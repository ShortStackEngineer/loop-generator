import { spawn } from "node:child_process";
import type { FeedbackSummary } from "./types";
import { augmentPromptWithStructuredFeedback } from "./structured-feedback";

/**
 * Shared plumbing for the "thin agentic CLI" drivers (grok, github-copilot,
 * opencode, and any future one): resolve a binary, spawn it scoped to the
 * workspace, buffer its output while honoring an AbortSignal, and parse the
 * JSON(L) it emits. Each driver keeps its own backend-specific parsing (which
 * event means "final answer", how usage is shaped) and layers it on top of
 * these primitives, so the boilerplate lives in exactly one place.
 */

// ─── JSON parsing ────────────────────────────────────────────────────────────

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** First finite number among the arguments, else undefined. */
export function numberOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

/**
 * Parse stdout as JSONL: one JSON object per line. Tolerates interleaved
 * non-JSON log lines (only lines beginning with `{` are attempted).
 */
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

/**
 * Parse stdout as a single JSON object/array first, falling back to line-by-line
 * (objects and arrays). More permissive than {@link parseJsonl}: use it for CLIs
 * that may emit one whole document instead of strict JSONL.
 */
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

// ─── Text shaping ────────────────────────────────────────────────────────────

/** Collapse whitespace and cap length so a summary can't blow up the output. */
export function cleanSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Last non-empty stderr line that isn't structured log noise — usually the real
 * error. Timestamped ERROR/WARN/INFO/DEBUG/TRACE lines are always dropped;
 * callers pass `extraNoise` patterns for tool-specific chatter (e.g. MCP spam).
 */
export function lastMeaningfulLine(stderr: string, extraNoise: RegExp[] = []): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(l))
    .filter((l) => !extraNoise.some((re) => re.test(l)));
  return lines.length ? lines[lines.length - 1]! : "";
}

/** Keep the last `max` chars, marking the truncation with a leading ellipsis. */
export function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return "…" + text.slice(-max);
}

/** Fold an optional system prompt in front of the concrete instruction. */
export function foldPrompt(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

/** Fold system + task prompt and append structured evaluator results when present. */
export function buildDriverPrompt(invocation: {
  systemPrompt?: string;
  prompt: string;
  feedback?: FeedbackSummary;
}): string {
  return augmentPromptWithStructuredFeedback(
    foldPrompt(invocation.systemPrompt, invocation.prompt),
    invocation.feedback,
  );
}

// ─── Binary resolution ───────────────────────────────────────────────────────

export interface ResolvedBin {
  command: string;
  argsPrefix: string[];
  /** Human-readable label for preflight notes/logging. */
  resolved: string;
}

// Stryker disable all: these helpers shell out to a real CLI (PATH probing,
// version checks) and can't be exercised in unit tests — the drivers' `*_BIN`
// override seam covers the explicit branch. Mirrors the pre-refactor drivers,
// where the equivalent resolve/probe code carried the same directive.
/** True if the command runs and exits 0 within a short safety timeout. */
export async function canRun(cmdAndArgs: string[], timeoutMs = 4000): Promise<boolean> {
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
      }, timeoutMs);
    });
    return code === 0;
  } catch {
    return false;
  }
}

export interface BinaryCandidate {
  command: string;
  argsPrefix?: string[];
  /** Args used to probe availability (default `["--version"]`). */
  probeArgs?: string[];
  /** Human-readable label recorded on the resolved binary. */
  resolved: string;
}

/**
 * Resolve an agent CLI: an explicit `$<envVar>` override wins unconditionally
 * (also the unit-test seam), otherwise the first candidate that runs. Returns
 * null when nothing is found so the driver can emit its own install hint.
 */
export async function resolveBinary(
  envVar: string,
  candidates: BinaryCandidate[],
): Promise<ResolvedBin | null> {
  const explicit = process.env[envVar];
  if (explicit) return { command: explicit, argsPrefix: [], resolved: explicit };
  for (const c of candidates) {
    const argsPrefix = c.argsPrefix ?? [];
    const probeArgs = c.probeArgs ?? ["--version"];
    if (await canRun([c.command, ...argsPrefix, ...probeArgs])) {
      return { command: c.command, argsPrefix, resolved: c.resolved };
    }
  }
  return null;
}

/**
 * Run `<bin> <extraArgs>` once, capturing stderr, with an optional timeout.
 * Used by preflight to prove the resolved binary actually responds.
 */
export async function probeVersion(
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

// ─── Spawn + collect ─────────────────────────────────────────────────────────

export interface SpawnCollectResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when we SIGKILLed the child because the AbortSignal fired. */
  killed: boolean;
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
}

/**
 * Spawn an agent CLI, buffer stdout/stderr, and honor an AbortSignal by
 * SIGKILLing the child. Resolves once the process closes (or fails to spawn) —
 * it never rejects, so callers branch on `spawnError` / `killed` / `exitCode`.
 * Optional `onStdout`/`onStderr` observe each chunk as it arrives, the hook a
 * future live-tracing path would use.
 */
export async function spawnCollect(
  bin: ResolvedBin,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): Promise<SpawnCollectResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let killed = false;
  let spawnError: string | undefined;

  try {
    const child = spawn(bin.command, [...bin.argsPrefix, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onStderr?.(text);
    });

    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          if (!child.killed) {
            killed = true;
            child.kill("SIGKILL");
          }
        },
        { once: true },
      );
      if (opts.signal.aborted) {
        killed = true;
        child.kill("SIGKILL");
      }
    }

    await new Promise<void>((resolve) => {
      child.on("error", (err) => {
        spawnError = err.message;
        resolve();
      });
      child.on("close", (code) => {
        exitCode = code;
        resolve();
      });
    });
  } catch (err) {
    spawnError = (err as Error).message;
  }

  return { stdout, stderr, exitCode, killed, spawnError };
}
