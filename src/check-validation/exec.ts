import { spawn, type ChildProcess } from "node:child_process";

export interface RunCheckCommandOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Hard timeout; always set by the manifest (default 10000). */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap captured output to avoid unbounded memory on chatty commands. */
  maxBuffer?: number;
}

export interface CheckCommandResult {
  /** Exit code, or null if killed by a signal / timeout / abort. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved roughly in arrival order. */
  combined: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

const DEFAULT_MAX_BUFFER = 1_000_000; // ~1MB per stream
/** If close never follows a kill, settle anyway so the run can continue. */
const KILL_SETTLE_MS = 2_000;

/**
 * Terminate an ordinary shell and its descendants.
 *
 * POSIX: the command is spawned as a new process-group leader (`detached`);
 * `kill(-pid, SIGKILL)` reaps the group, including typical grandchildren.
 *
 * Windows: `taskkill /T /F` ends the console process tree recorded for that
 * PID. Limits: processes that break away from the tree (`CREATE_BREAKAWAY_FROM_JOB`,
 * a fully detached spawn, scheduled tasks, WMI-started work) are not guaranteed
 * to stop — same class of escape as a POSIX child that calls `setsid()`.
 *
 * This is a trusted-command runner, not a security sandbox.
 */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone or never started */
    }
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      const done = (): void => resolve();
      killer.once("close", done);
      killer.once("error", () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        done();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a trusted shell command and capture bounded output.
 *
 * Unlike `runCommand` in core/exec, timeout and AbortSignal kill the ordinary
 * process group (POSIX) or process tree (Windows) and wait for cleanup so a
 * descendant cannot keep running after the deadline. Children that deliberately
 * leave the group/tree are not a security guarantee.
 */
export function runCheckCommand(
  command: string,
  opts: RunCheckCommandOptions,
): Promise<CheckCommandResult> {
  const start = Date.now();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted before start"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let combined = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stopping = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      // New process group on POSIX so we can signal the whole tree.
      // Windows uses taskkill /T instead; detached there only detaches a console.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });

    const append = (chunk: Buffer, stream: "out" | "err"): void => {
      const text = chunk.toString();
      if (stream === "out" && stdout.length < maxBuffer) stdout += text;
      if (stream === "err" && stderr.length < maxBuffer) stderr += text;
      if (combined.length < maxBuffer) combined += text;
    };

    child.stdout?.on("data", (c: Buffer) => append(c, "out"));
    child.stderr?.on("data", (c: Buffer) => append(c, "err"));

    const cleanupTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      timeoutTimer = undefined;
      forceSettleTimer = undefined;
    };

    const resultFrom = (code: number | null, signal: NodeJS.Signals | null): CheckCommandResult => ({
      code,
      signal,
      stdout,
      stderr,
      combined,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
    });

    const settleResolve = (result: CheckCommandResult): void => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    };

    const requestStop = (why: "timeout" | "abort"): void => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      if (stopping) return;
      stopping = true;
      void terminateProcessTree(child).finally(() => {
        if (settled) return;
        forceSettleTimer = setTimeout(() => {
          settleResolve(resultFrom(null, null));
        }, KILL_SETTLE_MS);
      });
    };

    const onAbort = (): void => requestStop("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => requestStop("timeout"), opts.timeoutMs);
    }

    if (opts.signal?.aborted) {
      requestStop("abort");
    }

    child.on("error", (err) => {
      // Timeout/abort kills can surface as errors on some platforms; those are
      // outcomes, not spawn failures.
      if (timedOut || aborted || opts.signal?.aborted) {
        settleResolve(resultFrom(null, null));
        return;
      }
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, signal) => {
      settleResolve(resultFrom(code, signal));
    });
  });
}
