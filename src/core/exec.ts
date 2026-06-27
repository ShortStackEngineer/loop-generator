import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Hard timeout for the command itself (separate from the iteration timeout). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap captured output to avoid unbounded memory on chatty commands. */
  maxBuffer?: number;
}

export interface RunCommandResult {
  /** Exit code, or null if killed by a signal. */
  code: number | null;
  /** Signal that killed the process, if any. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved roughly in arrival order. */
  combined: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_MAX_BUFFER = 1_000_000; // ~1MB per stream

/**
 * Run a shell command and capture its output. Uses `shell: true` so specs can
 * use familiar one-liners like `npm test && npm run lint`.
 */
export function runCommand(command: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  const start = Date.now();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted before start"));
      return;
    }

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...opts.env },
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    let combined = "";
    let timedOut = false;

    const append = (
      chunk: Buffer,
      stream: "out" | "err",
    ): void => {
      const text = chunk.toString();
      if (stream === "out" && stdout.length < maxBuffer) stdout += text;
      if (stream === "err" && stderr.length < maxBuffer) stderr += text;
      if (combined.length < maxBuffer) combined += text;
    };

    child.stdout?.on("data", (c: Buffer) => append(c, "out"));
    child.stderr?.on("data", (c: Buffer) => append(c, "err"));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      // AbortError surfaces here when the iteration signal fires.
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        combined,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

/** Keep the last `maxChars` of text (commands fail at the end far more often). */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…[${text.length - maxChars} earlier chars omitted]…\n${text.slice(-maxChars)}`;
}
