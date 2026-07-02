import { spawn } from "node:child_process";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";

const optionsSchema = z.object({
  /** Model id passed via --model. Omit for the CLI default. */
  model: z.string().optional(),
  /**
   * Auto-approve commands and edits (--force / --yolo). Required for non-interactive
   * (-p) runs, so it defaults on.
   */
  force: z.boolean().default(true),
  /**
   * Trust the workspace without prompting (--trust). Required for headless runs
   * in many setups, so it defaults on.
   */
  trust: z.boolean().default(true),
  /** Override sandbox mode (--sandbox enabled|disabled). */
  sandbox: z.enum(["enabled", "disabled"]).optional(),
  /** Automatically approve all MCP servers (--approve-mcps). */
  approveMcps: z.boolean().default(false),
  /**
   * Resume the previous iteration's session (--resume) when a session id is
   * available. Off by default.
   */
  resume: z.boolean().default(false),
  /** Extra environment variables for the cursor process. */
  env: z.record(z.string(), z.string()).optional(),
  /** Additional raw CLI args appended after the standard ones (advanced). */
  extraArgs: z.array(z.string()).optional(),
});

type CursorOptions = z.infer<typeof optionsSchema>;

/**
 * Drives Cursor Agent via the official `cursor agent` CLI in headless mode
 * (`-p`). Cursor is a real coding agent — it edits files and runs tools itself
 * — so this driver spawns it scoped to the workspace and parses its JSON output
 * for the summary, usage, and session id.
 *
 * The `cursor` CLI ships with Cursor IDE or can be installed standalone. Run
 * `cursor agent login` once, or set `CURSOR_API_KEY` for unattended runs.
 */
export const cursorDriver: AgentDriver = {
  name: "cursor",
  description: "Invoke Cursor Agent via the cursor CLI (headless -p).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `cursor options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const bin = await resolveCursorBinary();
    if (!bin) {
      return preflightFail([
        'The "cursor" CLI was not found. Install Cursor (https://cursor.com) or the standalone agent CLI, then run `cursor agent login`.',
      ]);
    }

    const warnings: string[] = [];
    if (!parsed.data.force) {
      warnings.push(
        "force is false, but the Cursor CLI requires --force (or --yolo) for non-interactive (-p) runs; the agent may refuse to act or hang waiting for confirmation.",
      );
    }
    if (!process.env.CURSOR_API_KEY) {
      warnings.push(
        "No CURSOR_API_KEY detected. The cursor CLI will use a cached login if you've signed in before (`cursor agent login`); otherwise unattended runs may fail to authenticate.",
      );
    }

    const probe = await runCursorOnce(bin, ["-v"], { timeoutMs: 8000 });
    if (!probe.ok) {
      warnings.push(`"cursor agent -v" check had issues: ${probe.error ?? "unknown"}`);
    }

    const modelNote = parsed.data.model ? `model: ${parsed.data.model}` : "model: (CLI default)";
    return preflightOk([modelNote, `binary: ${bin.resolved}`], warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    if (invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }

    const opts = optionsSchema.parse(invocation.options);
    const bin = await resolveCursorBinary();
    if (!bin) {
      return {
        ok: false,
        stopReason: "error",
        error: 'The "cursor" CLI is not installed. Install Cursor and run `cursor agent login`.',
      };
    }

    const effectivePrompt = invocation.systemPrompt
      ? `${invocation.systemPrompt}\n\n${invocation.prompt}`
      : invocation.prompt;

    const args: string[] = [
      "-p",
      effectivePrompt,
      "--workspace",
      invocation.workdir,
      "--output-format",
      "json",
    ];

    if (opts.force) {
      args.push("--force");
    }
    if (opts.trust) {
      args.push("--trust");
    }
    if (opts.approveMcps) {
      args.push("--approve-mcps");
    }
    if (opts.sandbox) {
      args.push("--sandbox", opts.sandbox);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.resume && invocation.resumeSessionId) {
      args.push("--resume", invocation.resumeSessionId);
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

    const objs = parseJsonObjects(stdout);
    const result = findResultEvent(objs);
    const finalText = extractFinalText(objs);
    const usage = extractUsage(objs);
    const sessionId = extractSessionId(objs);

    const lower = `${stderr}\n${stdout}`.toLowerCase();
    const hitMaxTurns = /max turns? reached|maximum (number of )?turns/.test(lower);
    const isAuthError =
      /not authenticated|authentication (failed|required)|please (log ?in|sign ?in)|cursor agent login|unauthori[sz]ed|invalid api key|missing api key|cursor_api_key (is )?(not set|missing|required)/.test(
        lower,
      );
    const resultError = result?.is_error === true || result?.subtype === "error";
    const isFatalError =
      isAuthError ||
      resultError ||
      (!hitMaxTurns && exitCode != null && exitCode !== 0);

    if (isFatalError) {
      const errMsg =
        (isAuthError
          ? "Cursor authentication required — run `cursor agent login` or set CURSOR_API_KEY."
          : undefined) ||
        extractError(objs) ||
        lastMeaningfulLine(stderr) ||
        `cursor CLI failed (exit ${exitCode ?? "unknown"})`;
      return {
        ok: false,
        stopReason: "error",
        error: errMsg,
        usage,
        sessionId,
        raw: { stdout: tail(stdout), stderr: tail(stderr), objects: objs.length, exitCode },
      };
    }

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
      summary: finalText ? cleanSummary(finalText) : "(cursor produced no parseable final summary; see report raw)",
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

/** Parse stdout as a single JSON object or as JSONL (one object per line). */
export function parseJsonObjects(stdout: string): JsonObject[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole.filter(isObject) : isObject(whole) ? [whole] : [];
  } catch {
    // fall through to line-by-line
  }
  const objs: JsonObject[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l[0] !== "{" && l[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(l);
      if (Array.isArray(parsed)) objs.push(...parsed.filter(isObject));
      else if (isObject(parsed)) objs.push(parsed);
    } catch {
      // skip non-JSON lines (logs)
    }
  }
  return objs;
}

export function findResultEvent(objs: JsonObject[]): JsonObject | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    if (objs[i]!.type === "result") return objs[i];
  }
  return undefined;
}

export function extractFinalText(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if (o.type === "result" && asString(o.result)) return o.result as string;
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const direct = asString(o.result) ?? asString(o.response) ?? asString(o.summary) ?? asString(o.text);
    if (direct) return direct;
  }
  return undefined;
}

export function extractUsage(objs: JsonObject[]): AgentUsage | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const u = isObject(o.usage) ? o.usage : undefined;
    if (u || o.num_turns != null) {
      return {
        inputTokens: numberOr(u?.inputTokens, u?.input_tokens, o.inputTokens),
        outputTokens: numberOr(u?.outputTokens, u?.output_tokens, o.outputTokens),
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
    if (o.type === "error" || o.is_error === true || o.error) {
      return asString(o.error) ?? asString(o.result) ?? asString(o.message) ?? undefined;
    }
  }
  return undefined;
}

function numberOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

export function cleanSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(l));
  return lines.length ? lines[lines.length - 1]! : "";
}

interface ResolvedBin {
  command: string;
  argsPrefix: string[];
  resolved: string;
}

// Stryker disable all: binary resolution shells out to a real `cursor` CLI and
// cannot be exercised in unit tests. Covered via the CURSOR_BIN override.
async function resolveCursorBinary(): Promise<ResolvedBin | null> {
  const explicit = process.env.CURSOR_BIN;
  if (explicit) {
    return { command: explicit, argsPrefix: ["agent"], resolved: explicit };
  }
  if (await canRun(["cursor", "agent", "-v"])) {
    return { command: "cursor", argsPrefix: ["agent"], resolved: "cursor agent (PATH)" };
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

async function runCursorOnce(
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

function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return "…" + text.slice(-max);
}
