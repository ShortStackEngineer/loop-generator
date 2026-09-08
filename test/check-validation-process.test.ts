import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { runCheckCommand, terminateProcessTree } from "../src/check-validation/exec";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
function child(pid: number | undefined = 123): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }) as unknown as ChildProcess;
}
let proc: ChildProcess;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "kill").mockReturnValue(true);
  proc = child();
  vi.mocked(spawn).mockReturnValue(proc);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("captures both streams in arrival order, preserving exit signal and elapsed time", async () => {
  const ac = new AbortController();
  const remove = vi.spyOn(ac.signal, "removeEventListener");
  const run = runCheckCommand("check --strict", { cwd: "/fixture", timeoutMs: 500, signal: ac.signal, env: { LOOPGEN_TEST: "yes" } });
  expect(spawn).toHaveBeenCalledWith("check --strict", {
    cwd: "/fixture", shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOOPGEN_TEST: "yes" }, windowsHide: true,
  });
  proc.stdout!.emit("data", Buffer.from("first"));
  proc.stderr!.emit("data", Buffer.from("problem"));
  proc.stdout!.emit("data", Buffer.from("last"));
  await vi.advanceTimersByTimeAsync(37);
  proc.emit("close", 7, "SIGTERM");
  expect(await run).toEqual({ code: 7, signal: "SIGTERM", stdout: "firstlast", stderr: "problem", combined: "firstproblemlast", durationMs: 37, timedOut: false, aborted: false });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  ac.abort();
  expect(process.kill).not.toHaveBeenCalled();
});

it("stops collecting each stream and combined output at the configured boundary", async () => {
  const run = runCheckCommand("chatty", { cwd: "/fixture", timeoutMs: 100, maxBuffer: 4 });
  for (const stream of [proc.stdout!, proc.stderr!]) {
    stream.emit("data", Buffer.from("1234"));
    stream.emit("data", Buffer.from("discard"));
  }
  proc.emit("close", 0, null);
  expect(await run).toMatchObject({ stdout: "1234", stderr: "1234", combined: "1234" });
});

it("honors a zero output budget", async () => {
  const run = runCheckCommand("chatty", { cwd: "/fixture", timeoutMs: 100, maxBuffer: 0 });
  proc.stdout!.emit("data", Buffer.from("discard"));
  proc.stderr!.emit("data", Buffer.from("discard"));
  proc.emit("close", 0, null);
  expect(await run).toMatchObject({ stdout: "", stderr: "", combined: "" });
});

it("uses the default million-character collection boundary", async () => {
  const run = runCheckCommand("chatty", { cwd: "/fixture", timeoutMs: 100 });
  proc.stdout!.emit("data", Buffer.from("x".repeat(1_000_000)));
  proc.stdout!.emit("data", Buffer.from("discard"));
  proc.emit("close", 0, null);
  const result = await run;
  expect(result.stdout).toBe("x".repeat(1_000_000));
  expect(result.combined).toBe(result.stdout);
});

it.each([new Error("spawn failed"), "spawn failed"])("rejects spawn errors and clears timer/listener %#", async (error) => {
  const ac = new AbortController();
  const remove = vi.spyOn(ac.signal, "removeEventListener");
  const run = runCheckCommand("missing", { cwd: "/fixture", timeoutMs: 100, signal: ac.signal });
  const rejected = expect(run).rejects.toThrow("spawn failed");
  proc.emit("error", error);
  await rejected;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  ac.abort();
  expect(process.kill).not.toHaveBeenCalled();
});

it.each(["timeout", "abort"])("settles after %s even when the child never emits close", async (why) => {
  const ac = new AbortController();
  const run = runCheckCommand("stuck", { cwd: "/fixture", timeoutMs: 100, signal: ac.signal });
  let finished = false;
  void run.then(() => { finished = true; });
  if (why === "abort") ac.abort();
  else await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(process.kill).toHaveBeenCalledWith(-123, "SIGKILL");
  await vi.advanceTimersByTimeAsync(1999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatchObject({ code: null, signal: null, timedOut: true, aborted: why === "abort" });
  expect(process.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["timeout", "abort"])("treats kill-related errors as %s outcomes", async (why) => {
  const ac = new AbortController();
  const run = runCheckCommand("stuck", { cwd: "/fixture", timeoutMs: 100, signal: ac.signal });
  if (why === "abort") ac.abort();
  else await vi.advanceTimersByTimeAsync(100);
  proc.emit("error", new Error("killed"));
  expect(await run).toMatchObject({ code: null, signal: null, timedOut: why === "timeout", aborted: why === "abort" });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the fallback timer when close follows a timeout", async () => {
  const run = runCheckCommand("slow", { cwd: "/fixture", timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(1);
  proc.emit("close", null, "SIGKILL");
  expect(await run).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  expect(vi.getTimerCount()).toBe(0);
});

it("handles cancellation during spawn before its listener is attached", async () => {
  const ac = new AbortController();
  vi.mocked(spawn).mockImplementation(() => { ac.abort(); return proc; });
  const run = runCheckCommand("racy", { cwd: "/fixture", timeoutMs: 100, signal: ac.signal });
  proc.emit("close", null, "SIGKILL");
  expect(await run).toMatchObject({ aborted: true, timedOut: false });
  expect(process.kill).toHaveBeenCalledWith(-123, "SIGKILL");
});

it.each([undefined, 0, -1])("never signals a process group for invalid pid %s", async (pid) => {
  proc = child();
  Object.defineProperty(proc, "pid", { value: pid });
  await terminateProcessTree(proc);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  expect(process.kill).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("falls back to the child when its process group is already gone", async () => {
  vi.mocked(process.kill).mockImplementation(() => { throw new Error("gone"); });
  await terminateProcessTree(proc);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  vi.mocked(proc.kill).mockImplementation(() => { throw new Error("also gone"); });
  await expect(terminateProcessTree(proc)).resolves.toBeUndefined();
});

it("waits for Windows taskkill and requests the full forced tree", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const killer = child(456);
  vi.mocked(spawn).mockReturnValue(killer);
  const stop = terminateProcessTree(proc);
  let finished = false;
  void stop.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(spawn).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "123"], { windowsHide: true, stdio: "ignore" });
  killer.emit("close", 0);
  await stop;
  expect(proc.kill).not.toHaveBeenCalled();
  expect(process.kill).not.toHaveBeenCalled();
});

it("falls back if Windows taskkill cannot start", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const killer = child(456);
  vi.mocked(spawn).mockReturnValue(killer);
  const stop = terminateProcessTree(proc);
  killer.emit("error", new Error("ENOENT"));
  await stop;
  expect(proc.kill).toHaveBeenCalledWith();
});

it("spawns Windows checks without a detached console", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const run = runCheckCommand("check", { cwd: "/fixture", timeoutMs: 0 });
  expect(spawn).toHaveBeenCalledWith("check", expect.objectContaining({ detached: false, shell: true, windowsHide: true }));
  expect(vi.getTimerCount()).toBe(0);
  proc.emit("close", 0, null);
  await run;
});
