import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

const optionsSchema = z.object({
  model: z.string().default(DEFAULT_MODEL),
  maxTurns: z.number().int().positive().default(40),
  /** Headless default: don't block on permission prompts. */
  permissionMode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan"])
    .default("bypassPermissions"),
  allowedTools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS),
  disallowedTools: z.array(z.string()).optional(),
  /** Resume the previous iteration's session (continues context) when available. */
  resume: z.boolean().default(false),
  /** Escape hatch: any extra options forwarded verbatim to `query({ options })`. */
  queryOptions: z.record(z.string(), z.unknown()).optional(),
});

// The SDK's types aren't guaranteed to be installed (it's an optional dep), so
// we model only what we touch and import it dynamically.
type SdkModule = {
  query: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
};
type SdkMessage = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

async function importSdk(): Promise<SdkModule | null> {
  try {
    // Indirect specifier keeps bundlers from trying to resolve the optional dep.
    return (await import(/* @vite-ignore */ SDK_PACKAGE)) as unknown as SdkModule;
  } catch {
    return null;
  }
}

function hasAuth(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX ||
      process.env.CLAUDE_CODE_USE_FOUNDRY ||
      process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS,
  );
}

/**
 * Drives Claude Code via the official Agent SDK. The agent runs headlessly in
 * the workspace, edits files, runs commands, and returns a summary. This is the
 * reference "real" driver; build new drivers against the same `AgentDriver`
 * contract and validate them with the conformance harness.
 */
export const claudeAgentSdkDriver: AgentDriver = {
  name: "claude-agent-sdk",
  description: "Invoke Claude Code through @anthropic-ai/claude-agent-sdk (headless).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `claude-agent-sdk options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const sdk = await importSdk();
    if (!sdk) {
      return preflightFail([
        `The optional dependency "${SDK_PACKAGE}" is not installed. Run: npm install ${SDK_PACKAGE}`,
      ]);
    }
    const warnings: string[] = [];
    if (!hasAuth()) {
      warnings.push(
        "No ANTHROPIC_API_KEY (or alt provider env) detected. The SDK may rely on an interactive Claude login; set credentials for unattended runs.",
      );
    }
    return preflightOk([`model: ${parsed.data.model}`, `permissionMode: ${parsed.data.permissionMode}`], warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    const opts = optionsSchema.parse(invocation.options);
    const sdk = await importSdk();
    if (!sdk) {
      return {
        ok: false,
        error: `"${SDK_PACKAGE}" is not installed; cannot run the claude-agent-sdk driver.`,
      };
    }

    const queryOptions: Record<string, unknown> = {
      cwd: invocation.workdir,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(invocation.systemPrompt ? { systemPrompt: invocation.systemPrompt } : {}),
      ...(opts.resume && invocation.resumeSessionId ? { resume: invocation.resumeSessionId } : {}),
      ...(invocation.signal ? { abortController: signalToController(invocation.signal) } : {}),
      ...(opts.queryOptions ?? {}),
    };

    let finalResult: string | undefined;
    let sessionId: string | undefined;
    let usage: AgentUsage | undefined;
    let stopReason: AgentRunResult["stopReason"] = "completed";
    const transcript: SdkMessage[] = [];

    try {
      for await (const message of sdk.query({ prompt: invocation.prompt, options: queryOptions })) {
        transcript.push(message);
        if (message.type === "system" && message.subtype === "init" && message.session_id) {
          sessionId = message.session_id;
        }
        if ("result" in message && typeof message.result === "string") {
          finalResult = message.result;
          usage = {
            inputTokens: message.usage?.input_tokens,
            outputTokens: message.usage?.output_tokens,
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
          };
          // Result-message subtype encodes how the run ended.
          const sub = (message.subtype ?? "").toLowerCase();
          if (sub.includes("max_turns")) stopReason = "max_turns";
          else if (sub && sub !== "success") stopReason = "error";
        }
      }
    } catch (err) {
      const aborted = invocation.signal?.aborted || /abort/i.test((err as Error).message);
      return {
        ok: false,
        stopReason: aborted ? "aborted" : "error",
        error: (err as Error).message,
        sessionId,
        raw: transcript,
      };
    }

    return {
      ok: stopReason !== "error",
      stopReason,
      summary: finalResult ?? "(agent produced no final summary)",
      usage,
      sessionId,
      raw: transcript,
    };
  },
};

function signalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
