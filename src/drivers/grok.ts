import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";
import {
  asString,
  cleanSummary,
  foldPrompt,
  isObject,
  lastMeaningfulLine as cliLastMeaningfulLine,
  numberOr,
  parseJsonObjects,
  probeVersion,
  resolveBinary,
  spawnCollect,
  tail,
} from "./cli";
import type { JsonObject, ResolvedBin } from "./cli";
import { unknownOptionWarnings } from "./options";

// Re-export the shared parsers the grok tests import from this module.
export { cleanSummary, parseJsonObjects };

/** Known `driver.options` keys (unknowns → preflight warnings). */
export const GROK_OPTION_KEYS = [
  "model",
  "maxTurns",
  "alwaysApprove",
  "env",
  "resume",
  "extraArgs",
] as const;

const optionsSchema = z.object({
  /** Model id to pass via -m / --model. If omitted, the grok CLI uses its configured default. */
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  /** Headless default: auto-approve edits and commands (bypass permission prompts). */
  alwaysApprove: z.boolean().default(true),
  /**
   * Extra environment variables for the grok process. Use this to point grok at
   * a clean/isolated config so the user's global MCP servers don't leak into the
   * coding loop (the source of the `mcp-search____IMPORTANT` collision noise).
   * e.g. { XDG_CONFIG_HOME: "/path/to/empty" } or a vendor-specific override.
   */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Resume the previous iteration's session (continues context) when one is
   * available. Off by default; only enable if your grok CLI supports `--resume`.
   */
  resume: z.boolean().default(false),
  /** Additional raw CLI args appended after the standard ones (advanced). */
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Drives Grok Build (xAI) via the official `grok` CLI in headless mode (`-p`).
 *
 * The `grok` CLI must be installed (e.g. `npm i -g @xai-official/grok` or the
 * official install script). Authentication uses `XAI_API_KEY` or an interactive
 * login (browser) stored under the user's Grok config.
 *
 * This is the reference driver for the Grok coding agent, symmetric to
 * claude-agent-sdk. Shared CLI plumbing (binary resolution, spawn/collect, JSON
 * parsing, text shaping) lives in `./cli`.
 */
export const grokDriver: AgentDriver = {
  name: "grok",
  description: "Invoke Grok Build via the grok CLI (headless -p).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `grok options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const bin = await resolveGrokBinary();
    if (!bin) {
      return preflightFail([
        'The "grok" CLI was not found. Install with: npm i -g @xai-official/grok  or  curl -fsSL https://x.ai/cli/install.sh | bash',
      ]);
    }

    const warnings: string[] = [...unknownOptionWarnings("grok", options, GROK_OPTION_KEYS)];
    if (!process.env.XAI_API_KEY) {
      warnings.push(
        "No XAI_API_KEY detected. The grok CLI will use a cached login if you've signed in before; otherwise it may require an interactive login (opens browser) or a key for unattended runs.",
      );
    }

    // Quick probe that the binary responds.
    const probe = await probeVersion(bin, ["--version"], { timeoutMs: 8000 });
    if (!probe.ok) {
      warnings.push(`"grok --version" check had issues: ${probe.error ?? "unknown"}`);
    }

    const modelNote = parsed.data.model ? `model: ${parsed.data.model}` : "model: (CLI default)";
    const notes = [modelNote, `binary: ${bin.resolved}`];
    return preflightOk(notes, warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    const opts = optionsSchema.parse(invocation.options);
    const bin = await resolveGrokBinary();
    if (!bin) {
      return {
        ok: false,
        error: 'The "grok" CLI is not installed. Run: npm i -g @xai-official/grok',
      };
    }

    // Fold systemPrompt (if any) at the front so the agent receives role framing
    // + the concrete ask. Grok Build also picks up AGENTS.md etc.
    const effectivePrompt = foldPrompt(invocation.systemPrompt, invocation.prompt);

    const args: string[] = [
      "-p",
      effectivePrompt,
      "--cwd",
      invocation.workdir,
      "--output-format",
      "json",
    ];

    if (opts.alwaysApprove) {
      args.push("--always-approve");
    }
    if (opts.model) {
      args.push("-m", opts.model);
    }
    if (opts.maxTurns != null) {
      args.push("--max-turns", String(opts.maxTurns));
    }
    if (opts.resume && invocation.resumeSessionId) {
      args.push("--resume", invocation.resumeSessionId);
    }
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Ensure non-interactive behavior where possible.
      GROK_HEADLESS: "1",
      ...opts.env,
    };

    const res = await spawnCollect(bin, args, {
      cwd: invocation.workdir,
      env: childEnv,
      signal: invocation.signal,
    });
    // Abort wins over an incidental spawn error: an already-aborted signal makes
    // `spawn({ signal })` emit an immediate AbortError, which must still read as
    // "aborted", not as a spawn failure.
    if (res.killed || invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }
    if (res.spawnError) {
      return { ok: false, error: res.spawnError };
    }
    const { stdout, stderr, exitCode } = res;

    // Parse --output-format json. grok may emit a single object or JSONL (one
    // event per line); collect every object so we can pull the FINAL answer
    // rather than the reasoning stream.
    const objs = parseJsonObjects(stdout);
    const finalText = extractFinalText(objs);
    const usage = extractUsage(objs);
    const sessionId = extractSessionId(objs);

    // "max turns reached" is the agent running out of budget, NOT a crash. The
    // CLI may still exit non-zero, so detect it before classifying as fatal.
    const lower = `${stderr}\n${stdout}`.toLowerCase();
    const hitMaxTurns = /max turns? reached|maximum (number of )?turns/.test(lower);

    // Auth problems are genuine failures. Match precise phrases, not bare words
    // like "login", so unrelated tool logs aren't misread as auth errors.
    const isAuthError =
      /not authori[sz]ed|authentication (failed|required)|please (log ?in|sign ?in)|invalid api key|missing api key|xai_api_key (is )?(not set|missing|required)/.test(
        lower,
      );

    // A genuine fatal error: non-zero exit that isn't just "out of turns".
    const isFatalError = !hitMaxTurns && exitCode != null && exitCode !== 0;

    if (isAuthError || isFatalError) {
      // Prefer a structured error; else the LAST meaningful stderr line. Never
      // slice raw stdout (which is mostly the agent's reasoning stream).
      const errMsg =
        extractError(objs) ||
        lastMeaningfulLine(stderr) ||
        `grok CLI failed (exit ${exitCode ?? "unknown"})`;
      invocation.emit?.({ kind: "error", message: errMsg });
      return {
        ok: false,
        stopReason: "error",
        error: errMsg,
        usage,
        sessionId,
        raw: { stdout: tail(stdout), stderr: tail(stderr), objects: objs.length, exitCode },
      };
    }

    // Coarse trajectory: grok's stream shape is loosely structured, so surface
    // the final answer as a single model-message (both max_turns and completed
    // reach here). Per-turn/tool events would need grok's event schema sampled.
    if (invocation.emit && finalText) invocation.emit({ kind: "model-message", text: finalText });

    // max_turns: the agent did real work but didn't self-terminate. Report it as
    // a successful-but-incomplete run so the engine can warn / resume rather than
    // treating partial progress as a crash.
    if (hitMaxTurns) {
      return {
        ok: true,
        stopReason: "max_turns",
        summary: finalText ? cleanSummary(finalText) : "agent reached its turn limit before finishing",
        usage,
        sessionId,
        raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode },
      };
    }

    return {
      ok: true,
      stopReason: "completed",
      summary: finalText ? cleanSummary(finalText) : "(grok produced no parseable final summary; see report raw)",
      usage,
      sessionId,
      raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode },
    };
  },
};

/** Pull the agent's final answer, preferring an explicit result event. */
export function extractFinalText(objs: JsonObject[]): string | undefined {
  // 1) An explicit result/completion event.
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if ((o.type === "result" || o.subtype === "result") && asString(o.result)) return o.result as string;
  }
  // 2) The last object exposing a final-answer field.
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const direct = asString(o.result) ?? asString(o.response) ?? asString(o.final) ?? asString(o.summary) ?? asString(o.text);
    if (direct) return direct;
    // assistant message with a content array of text parts
    if (o.role === "assistant" && Array.isArray(o.content)) {
      const text = o.content
        .map((c) => (typeof c === "string" ? c : isObject(c) ? asString(c.text) : undefined))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return undefined;
}

export function extractUsage(objs: JsonObject[]): AgentUsage | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const u = isObject(o.usage) ? o.usage : undefined;
    const hasCost = o.total_cost_usd != null || o.cost_usd != null;
    if (u || hasCost || o.num_turns != null) {
      return {
        inputTokens: numberOr(u?.input_tokens, o.inputTokens),
        outputTokens: numberOr(u?.output_tokens, o.outputTokens),
        costUsd: numberOr(o.total_cost_usd, u?.cost_usd, o.cost_usd),
        turns: numberOr(u?.turns, o.turns, o.num_turns),
      };
    }
  }
  return undefined;
}

export function extractSessionId(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const id = asString(o.session_id) ?? asString(o.sessionId);
    if (id) return id;
  }
  return undefined;
}

export function extractError(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if (o.type === "error" || o.error || o.is_error) {
      return asString(o.error) ?? asString(o.message) ?? undefined;
    }
  }
  return undefined;
}

/**
 * Last meaningful stderr line, additionally dropping grok's MCP tool chatter
 * (the `mcp-search____IMPORTANT` collision noise) on top of the shared filters.
 */
export function lastMeaningfulLine(stderr: string): string {
  return cliLastMeaningfulLine(stderr, [/skipping mcp tool|tool_output_error|tool_error/i]);
}

// Stryker disable all: binary resolution shells out to a real `grok`/`npx` CLI
// and cannot be exercised in unit tests (it would require the external tool /
// network). Covered indirectly via the GROK_BIN override in the driver tests.
async function resolveGrokBinary(): Promise<ResolvedBin | null> {
  return resolveBinary("GROK_BIN", [
    // "grok" in PATH (preferred — after global npm install or official installer).
    { command: "grok", resolved: "grok (PATH)" },
    // Fallback via npx (downloads on first use if not cached).
    { command: "npx", argsPrefix: ["--yes", "@xai-official/grok"], resolved: "npx --yes @xai-official/grok" },
  ]);
}
// Stryker restore all
