import { spawn } from "node:child_process";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";

const optionsSchema = z.object({
  /**
   * Model id passed via -m, in OpenCode's `provider/model` form. For a local
   * LM Studio setup this looks like `lmstudio/qwen/qwen3-coder-next`. Omit to use
   * whatever model OpenCode is configured to default to.
   */
  model: z.string().optional(),
  /** Named OpenCode agent to run as (--agent). Omit for the default agent. */
  agent: z.string().optional(),
  /** Provider-specific reasoning variant/effort (--variant), e.g. "high", "max". */
  variant: z.string().optional(),
  /**
   * Auto-approve tool use so the agent can edit files unattended
   * (--dangerously-skip-permissions). Headless runs need this; with it off,
   * OpenCode will block on a permission prompt and the iteration will stall, so
   * it defaults on.
   */
  dangerouslySkipPermissions: z.boolean().default(true),
  /**
   * Run without external plugins (--pure). Useful to keep the user's globally
   * configured plugins / MCP servers from leaking into the loop as noise. Off by
   * default so the agent behaves like the user's normal setup.
   */
  pure: z.boolean().default(false),
  /**
   * Continue the previous iteration's session (--session <id>) when a session id
   * is available (e.g. after an incomplete stop). Off by default.
   */
  resume: z.boolean().default(false),
  /**
   * Extra environment variables for the opencode process (e.g. a sandboxed
   * XDG_CONFIG_HOME, or provider credentials for an unattended run).
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Additional raw CLI args appended after the standard ones (advanced). */
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Drives OpenCode (the agentic `opencode` CLI) in headless mode
 * (`opencode run … --format json`). OpenCode is a real coding agent — it edits
 * files and runs tools itself — so this driver just spawns it scoped to the
 * workspace (`--dir`) and parses its JSONL event stream for the final text,
 * session id, and token usage. Symmetric to the grok and github-copilot drivers
 * (thin agentic CLI).
 *
 * The `opencode` CLI must be installed (e.g. `brew install sst/tap/opencode`,
 * `npm i -g opencode-ai`, or `curl -fsSL https://opencode.ai/install | bash`)
 * and configured with a provider. This driver is provider-agnostic: point the
 * `model` option at any provider OpenCode knows about — including a local
 * LM Studio endpoint, e.g. `model: "lmstudio/qwen/qwen3-coder-next"`.
 */
export const opencodeDriver: AgentDriver = {
  name: "opencode",
  description: "Invoke OpenCode in headless mode (opencode run --format json).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `opencode options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const bin = await resolveOpencodeBinary();
    if (!bin) {
      return preflightFail([
        'The "opencode" CLI was not found. Install OpenCode (e.g. `brew install sst/tap/opencode`, `npm i -g opencode-ai`, or `curl -fsSL https://opencode.ai/install | bash`), then configure a provider/model.',
      ]);
    }

    const warnings: string[] = [];
    if (!parsed.data.dangerouslySkipPermissions) {
      warnings.push(
        "dangerouslySkipPermissions is false, but headless `opencode run` needs it to apply edits without a permission prompt; the agent may stall waiting for confirmation.",
      );
    }

    // Quick probe that the binary responds.
    const probe = await runOpencodeOnce(bin, ["--version"], { timeoutMs: 8000 });
    if (!probe.ok) {
      warnings.push(`"opencode --version" check had issues: ${probe.error ?? "unknown"}`);
    }

    const modelNote = parsed.data.model ? `model: ${parsed.data.model}` : "model: (CLI default)";
    return preflightOk([modelNote, `binary: ${bin.resolved}`], warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    if (invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }

    const opts = optionsSchema.parse(invocation.options);
    const bin = await resolveOpencodeBinary();
    if (!bin) {
      return {
        ok: false,
        stopReason: "error",
        error: 'The "opencode" CLI is not installed. Install OpenCode and configure a provider/model.',
      };
    }

    // Fold systemPrompt (if any) in front of the concrete ask. OpenCode also
    // picks up AGENTS.md / project rules from the workspace on its own. The
    // prompt is passed as the positional `message` to `opencode run`.
    const effectivePrompt = invocation.systemPrompt
      ? `${invocation.systemPrompt}\n\n${invocation.prompt}`
      : invocation.prompt;

    const args: string[] = [
      "run",
      effectivePrompt,
      // Confine the agent to the workspace directory.
      "--dir",
      invocation.workdir,
      "--format",
      "json",
      "--log-level",
      "ERROR",
    ];

    if (opts.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (opts.pure) {
      args.push("--pure");
    }
    if (opts.model) {
      args.push("-m", opts.model);
    }
    if (opts.agent) {
      args.push("--agent", opts.agent);
    }
    if (opts.variant) {
      args.push("--variant", opts.variant);
    }
    if (opts.resume && invocation.resumeSessionId) {
      args.push("--session", invocation.resumeSessionId);
    }
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
    };

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let killed = false;

    try {
      const child = spawn(bin.command, [...bin.argsPrefix, ...args], {
        cwd: invocation.workdir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        signal: invocation.signal,
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if (invocation.signal) {
        invocation.signal.addEventListener(
          "abort",
          () => {
            if (!child.killed) {
              killed = true;
              child.kill("SIGKILL");
            }
          },
          { once: true },
        );
        if (invocation.signal.aborted) {
          killed = true;
          child.kill("SIGKILL");
        }
      }

      await new Promise<void>((resolve) => {
        child.on("error", () => resolve());
        child.on("close", (code) => {
          exitCode = code;
          resolve();
        });
      });
    } catch (err) {
      return { ok: false, stopReason: "error", error: (err as Error).message };
    }

    if (killed || invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }

    // OpenCode emits JSONL: a stream of step_start / text / tool / step_finish
    // events, plus an `error` event for a backend/provider failure.
    const objs = parseJsonl(stdout);
    const finalText = finalAssistantText(objs);
    const usage = extractUsage(objs);
    const sessionId = extractSessionId(objs);
    const errEvent = extractError(objs);

    // A backend/provider error (e.g. an LM Studio model misconfig) surfaces as an
    // `error` event; a non-zero exit without one is still a real failure.
    const isFatal = errEvent != null || (exitCode != null && exitCode !== 0);

    if (isFatal) {
      const errMsg =
        formatErrorEvent(errEvent) ||
        lastMeaningfulLine(stderr) ||
        (finalText ? cleanSummary(finalText) : undefined) ||
        `opencode CLI failed (exit ${exitCode ?? "unknown"})`;
      return {
        ok: false,
        stopReason: "error",
        error: errMsg,
        usage,
        sessionId,
        raw: { stdout: tail(stdout), stderr: tail(stderr), objects: objs.length, exitCode },
      };
    }

    // Headless `opencode run` executes until the model stops, so a clean exit is
    // a completed iteration (there is no mid-run turn budget to recover from).
    return {
      ok: true,
      stopReason: "completed",
      summary: finalText ? cleanSummary(finalText) : "(opencode produced no parseable final summary; see report raw)",
      usage,
      sessionId,
      raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode },
    };
  },
};

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function numberOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

/** OpenCode emits JSONL (one JSON object per line). Tolerate interleaved log lines. */
export function parseJsonl(stdout: string): JsonObject[] {
  const objs: JsonObject[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] !== "{") continue;
    try {
      const parsed: unknown = JSON.parse(l);
      if (isObject(parsed)) objs.push(parsed);
    } catch {
      // skip non-JSON log lines
    }
  }
  return objs;
}

/** The `part` object of an event, if the event carries one. */
function partOf(o: JsonObject): JsonObject | undefined {
  return isObject(o.part) ? o.part : undefined;
}

/** True if this event is a `text` part (the model's text output). */
function isTextEvent(o: JsonObject): boolean {
  if (o.type === "text") return true;
  const part = partOf(o);
  return part?.type === "text";
}

/** True if this event is a step-finish (carries the reason + token usage). */
function isStepFinish(o: JsonObject): boolean {
  if (o.type === "step_finish") return true;
  const part = partOf(o);
  return part?.type === "step-finish";
}

/**
 * The assistant's text output, assembled from `text` events. Successive events
 * can re-emit the growing snapshot of the same part, so we keep the latest text
 * per part id (preserving first-seen order) and join distinct parts.
 */
export function finalAssistantText(objs: JsonObject[]): string | undefined {
  const byPart = new Map<string, string>();
  let anon = 0;
  for (const o of objs) {
    if (!isTextEvent(o)) continue;
    const part = partOf(o);
    const text = asString(part?.text);
    if (!text) continue;
    const id = asString(part?.id) ?? `__anon_${anon++}`;
    byPart.set(id, text);
  }
  if (byPart.size === 0) return undefined;
  const joined = [...byPart.values()].join("\n").trim();
  return joined || undefined;
}

/** Top-level session id (`ses_…`), taken from the last event that carries one. */
export function extractSessionId(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const id = asString(objs[i]!.sessionID) ?? asString(objs[i]!.sessionId);
    if (id) return id;
  }
  return undefined;
}

/** Sum token usage and cost across all step_finish events; count steps as turns. */
export function extractUsage(objs: JsonObject[]): AgentUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasCost = false;
  let turns = 0;
  for (const o of objs) {
    if (!isStepFinish(o)) continue;
    turns++;
    const part = partOf(o);
    const tokens = isObject(part?.tokens) ? part.tokens : undefined;
    const inTok = numberOr(tokens?.input);
    const outTok = numberOr(tokens?.output);
    const cost = numberOr(part?.cost);
    if (inTok != null) {
      inputTokens += inTok;
      hasInput = true;
    }
    if (outTok != null) {
      outputTokens += outTok;
      hasOutput = true;
    }
    if (cost != null) {
      costUsd += cost;
      hasCost = true;
    }
  }
  const usage: AgentUsage = {};
  if (hasInput) usage.inputTokens = inputTokens;
  if (hasOutput) usage.outputTokens = outputTokens;
  if (hasCost) usage.costUsd = costUsd;
  if (turns > 0) usage.turns = turns;
  return Object.keys(usage).length ? usage : undefined;
}

export interface OpencodeError {
  name?: string;
  message?: string;
}

/** The last `error` event's name + message, if the stream reported a failure. */
export function extractError(objs: JsonObject[]): OpencodeError | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if (o.type !== "error") continue;
    const err = isObject(o.error) ? o.error : undefined;
    if (!err) return { message: "opencode reported an error" };
    const data = isObject(err.data) ? err.data : undefined;
    return {
      name: asString(err.name),
      message: asString(data?.message) ?? asString(err.message),
    };
  }
  return undefined;
}

/** Render an error event into a single actionable line. */
export function formatErrorEvent(err: OpencodeError | undefined): string | undefined {
  if (!err) return undefined;
  const msg = err.message;
  if (msg && err.name && err.name !== "Error") return `${err.name}: ${msg}`;
  return msg ?? err.name;
}

/** Collapse whitespace and cap length so a summary can't blow up the output. */
export function cleanSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Last non-empty, non-timestamped-log line of stderr — usually the real error. */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(l));
  return lines.length ? lines[lines.length - 1]! : "";
}

function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return "…" + text.slice(-max);
}

interface ResolvedBin {
  command: string;
  argsPrefix: string[];
  resolved: string; // for notes/logging
}

// Stryker disable all: binary resolution shells out to a real `opencode` CLI and
// cannot be exercised in unit tests (it would require the external tool /
// provider). Covered indirectly via the OPENCODE_BIN override in the driver tests.
async function resolveOpencodeBinary(): Promise<ResolvedBin | null> {
  // 1) Explicit override (also the unit-test seam).
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) {
    return { command: explicit, argsPrefix: [], resolved: explicit };
  }
  // 2) "opencode" in PATH (after brew / npm global install / install script).
  if (await canRun(["opencode", "--version"])) {
    return { command: "opencode", argsPrefix: [], resolved: "opencode (PATH)" };
  }
  return null;
}

async function canRun(cmdAndArgs: string[]): Promise<boolean> {
  try {
    const [cmd, ...args] = cmdAndArgs;
    const child = spawn(cmd!, args, { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (c) => resolve(c));
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve(1);
      }, 4000);
    });
    return code === 0;
  } catch {
    return false;
  }
}

async function runOpencodeOnce(
  bin: ResolvedBin,
  extraArgs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin.command, [...bin.argsPrefix, ...extraArgs], { stdio: "pipe" });

    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c));

    let done = false;
    const finish = (ok: boolean, error?: string): void => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok, error });
    };

    const t = opts.timeoutMs ? setTimeout(() => finish(false, "timeout"), opts.timeoutMs) : undefined;

    child.on("error", (e) => {
      if (t) clearTimeout(t);
      finish(false, e.message);
    });
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      if (code === 0) finish(true);
      else finish(false, err || `exit ${code}`);
    });
  });
}
// Stryker restore all
