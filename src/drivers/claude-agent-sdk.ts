import path from "node:path";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentEvent, AgentInvocation, AgentRunResult, AgentUsage } from "./types";
import { augmentPromptWithStructuredFeedback, emitStructuredFeedbackEvents } from "./structured-feedback";
import { unknownOptionWarnings } from "./options";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

/** Known `driver.options` keys for this backend (unknowns → preflight warnings). */
export const CLAUDE_SDK_OPTION_KEYS = [
  "model",
  "maxTurns",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "resume",
  "queryOptions",
] as const;

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

/** Tools that edit the workspace — their inputs yield paths for changedFiles. */
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create_file",
  "edit_file",
  "str_replace",
  "str_replace_editor",
]);

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

// Stryker disable all: dynamic import of an optional, externally-authenticated
// package; the failure path can't be exercised in unit tests (the package is
// installed). The driver is tested via the injectable loader seam below.
async function importSdk(): Promise<SdkModule | null> {
  try {
    // Indirect specifier keeps bundlers from trying to resolve the optional dep.
    return (await import(/* @vite-ignore */ SDK_PACKAGE)) as unknown as SdkModule;
  } catch {
    return null;
  }
}
// Stryker restore all

// Test seam: the SDK is an optional, externally-authenticated dependency, so
// tests swap in a fake loader rather than invoking the real agent.
let sdkLoader: () => Promise<SdkModule | null> = importSdk;

/** @internal — for tests only. Pass null to restore the real loader. */
export function __setSdkLoaderForTests(loader: (() => Promise<SdkModule | null>) | null): void {
  sdkLoader = loader ?? importSdk;
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
    const sdk = await sdkLoader();
    if (!sdk) {
      return preflightFail([
        `The optional dependency "${SDK_PACKAGE}" is not installed. Run: npm install ${SDK_PACKAGE}`,
      ]);
    }
    const warnings: string[] = [
      ...unknownOptionWarnings("claude-agent-sdk", options, CLAUDE_SDK_OPTION_KEYS),
    ];
    if (!hasAuth()) {
      warnings.push(
        "No ANTHROPIC_API_KEY (or alt provider env) detected. The SDK may rely on an interactive Claude login; set credentials for unattended runs.",
      );
    }
    return preflightOk([`model: ${parsed.data.model}`, `permissionMode: ${parsed.data.permissionMode}`], warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    const opts = optionsSchema.parse(invocation.options);
    const sdk = await sdkLoader();
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
    const turnState = { turn: 0 };
    const agentPrompt = augmentPromptWithStructuredFeedback(invocation.prompt, invocation.feedback);
    emitStructuredFeedbackEvents(invocation.emit, invocation.feedback);

    try {
      for await (const message of sdk.query({ prompt: agentPrompt, options: queryOptions })) {
        transcript.push(message);
        if (invocation.emit) emitSdkEvents(message, invocation.emit, turnState);
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
      if (!aborted) invocation.emit?.({ kind: "error", message: (err as Error).message });
      return {
        ok: false,
        stopReason: aborted ? "aborted" : "error",
        error: (err as Error).message,
        sessionId,
        raw: transcript,
      };
    }

    const changedFiles = extractChangedFilesFromTranscript(transcript, invocation.workdir);

    return {
      ok: stopReason !== "error",
      stopReason,
      summary: finalResult ?? "(agent produced no final summary)",
      changedFiles: changedFiles.length ? changedFiles : undefined,
      usage,
      sessionId,
      raw: transcript,
    };
  },
};

/**
 * Collect workspace-relative paths the agent wrote/edited from tool_use blocks
 * in the SDK transcript. Supports both Claude Code (`file_path`) and shorter
 * `path` keys; absolute paths are relativized to `workdir`.
 *
 * @internal exported for unit tests
 */
export function extractChangedFilesFromTranscript(transcript: SdkMessage[], workdir: string): string[] {
  const files = new Set<string>();
  for (const message of transcript) {
    if (message.type !== "assistant") continue;
    const inner = isRecord(message.message) ? message.message : undefined;
    const content: unknown[] = inner && Array.isArray(inner.content) ? inner.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (!WRITE_TOOLS.has(name) && !/write|edit|replace/i.test(name)) continue;
      for (const p of pathsFromToolInput(block.input)) {
        const rel = toWorkdirRel(p, workdir);
        if (rel) files.add(rel);
      }
    }
  }
  return [...files].sort();
}

function pathsFromToolInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const out: string[] = [];
  for (const key of ["file_path", "filePath", "path", "file", "notebook_path", "notebookPath"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  // MultiEdit-style: edits: [{ file_path }]
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!isRecord(e)) continue;
      for (const key of ["file_path", "filePath", "path"]) {
        const v = e[key];
        if (typeof v === "string" && v.trim()) out.push(v.trim());
      }
    }
  }
  return out;
}

function toWorkdirRel(p: string, workdir: string): string | null {
  const abs = path.isAbsolute(p) ? p : path.resolve(workdir, p);
  const rel = path.relative(workdir, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function signalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Translate one Agent SDK message into vendor-neutral {@link AgentEvent}s. The
 * driver already walks every message for the final result; this reads the same
 * message with no extra iteration. Assistant messages carry text + `tool_use`
 * blocks (each assistant message counts as a turn); the matching tool results
 * come back in the following `user` message, still within that turn (the counter
 * only advances on the next assistant message). Every model message, tool call,
 * and tool result is stamped with its turn so a sink can nest tool calls under
 * per-turn spans. Structured `input`/`output` pass through untouched — bounding
 * them is the sink's job, not the driver's.
 */
function emitSdkEvents(message: SdkMessage, emit: (e: AgentEvent) => void, turnState: { turn: number }): void {
  const inner = isRecord(message.message) ? message.message : undefined;
  const content: unknown[] = inner && Array.isArray(inner.content) ? inner.content : [];

  if (message.type === "assistant") {
    turnState.turn += 1;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        emit({ kind: "model-message", text: block.text, turn: turnState.turn });
      } else if (block.type === "tool_use") {
        emit({
          kind: "tool-call",
          name: typeof block.name === "string" ? block.name : "unknown",
          id: typeof block.id === "string" ? block.id : undefined,
          turn: turnState.turn,
          input: block.input,
        });
      }
    }
  } else if (message.type === "user") {
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      emit({
        kind: "tool-result",
        id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        ok: block.is_error !== true,
        turn: turnState.turn,
        output: block.content,
      });
    }
  }
}
