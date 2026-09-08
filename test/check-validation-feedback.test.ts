import { beforeEach, expect, it, vi } from "vitest";
import { runCheckCommand, type CheckCommandResult } from "../src/check-validation/exec";
import { inspectFixture, withIsolatedFixture } from "../src/check-validation/fixtures";
import { parseChecksManifest } from "../src/check-validation/manifest";
import { runCheckValidation } from "../src/check-validation/runner";

vi.mock("../src/check-validation/exec", () => ({ runCheckCommand: vi.fn() }));
vi.mock("../src/check-validation/fixtures", async (original) => ({
  ...await original<typeof import("../src/check-validation/fixtures")>(),
  inspectFixture: vi.fn(), withIsolatedFixture: vi.fn(),
}));
const manifest = () => parseChecksManifest({
  version: 1, name: "receipt", goal: "explain outcomes", assumptions: ["trusted commands"], gaps: ["limited fixtures"],
  claims: [{ id: "claim", description: "fault detected", checks: ["check"] }],
  checks: [{ id: "check", command: "check --strict", timeoutMs: 321, rejectExitCodes: [10] }],
  control: { dir: "good" }, counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
});
const result = (over: Partial<CheckCommandResult> = {}): CheckCommandResult => ({
  code: 0, signal: null, stdout: "", stderr: "", combined: "", durationMs: 5, timedOut: false, aborted: false, ...over,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(withIsolatedFixture).mockImplementation(async (_dir, _label, fn) => fn("/copy/fixture"));
  vi.mocked(runCheckCommand).mockResolvedValue(result());
});

it.each([
  [result({ code: 10, combined: "  bad answer\n" }), "rejected", "`check --strict` → exit 10 ✗\n\noutput:\nbad answer"],
  [result({ code: 2 }), "error", "`check --strict` → exit 2 !\n\noutput:\n(no output)"],
  [result({ code: null, signal: "SIGTERM" }), "error", "`check --strict` → killed (signal SIGTERM) !\n\noutput:\n(no output)"],
  [result({ code: null }), "error", "`check --strict` → killed !\n\noutput:\n(no output)"],
  [result({ timedOut: true }), "error", "`check --strict` → TIMED OUT !\n\noutput:\n(no output)"],
  [result({ aborted: true }), "error", "`check --strict` → ABORTED !\n\noutput:\n(no output)"],
  [result({ code: 10, signal: "SIGTERM" }), "rejected", "`check --strict` → exit 10 (signal SIGTERM) ✗\n\noutput:\n(no output)"],
])("preserves diagnostic evidence for %#", async (execution, status, feedback) => {
  vi.mocked(runCheckCommand).mockResolvedValueOnce(result({ combined: "successful output omitted" })).mockResolvedValueOnce(execution);
  const signal = new AbortController().signal;
  const report = await runCheckValidation(manifest(), { baseDir: "/fixtures", signal });
  expect(report.control).toEqual([{ check: "check", status: "passed", exitCode: 0, feedback: "`check --strict` → exit 0 ✓" }]);
  expect(report.counterexamples[0]?.checks).toEqual([{ check: "check", status, exitCode: execution.code, feedback }]);
  expect(runCheckCommand).toHaveBeenCalledWith("check --strict", { cwd: "/copy/fixture", timeoutMs: 321, signal });
  expect(inspectFixture).toHaveBeenNthCalledWith(1, "/fixtures/good", "control");
  expect(inspectFixture).toHaveBeenNthCalledWith(2, "/fixtures/bad", 'counterexample "fault"');
});

it.each([undefined, 12, 0])("bounds failure evidence with feedbackChars=%s", async (feedbackChars) => {
  const output = "begin" + "x".repeat(4000) + "end";
  vi.mocked(runCheckCommand).mockResolvedValue(result({ code: 2, combined: output }));
  const report = await runCheckValidation(manifest(), { baseDir: "/fixtures", feedbackChars });
  const { tail } = await import("../src/core/exec");
  expect(report.control[0]?.feedback).toBe("`check --strict` → exit 2 !\n\noutput:\n" + tail(output, feedbackChars ?? 3000));
  expect(report).toMatchObject({ name: "receipt", goal: "explain outcomes", assumptions: ["trusted commands"], gaps: ["limited fixtures"], counterexamples: [], claims: [{ id: "claim", description: "fault detected", status: "error" }] });
});

it.each([
  [new Error("spawn denied"), "Could not run `check --strict`: spawn denied"],
  ["transport failed", "Could not run `check --strict`: transport failed"],
  [new Error("ABORT requested"), "aborted: ABORT requested"],
])("reports command exceptions %#", async (error, feedback) => {
  vi.mocked(runCheckCommand).mockRejectedValue(error);
  const report = await runCheckValidation(manifest(), { baseDir: "/fixtures" });
  expect(report.control).toEqual([{ check: "check", status: "error", exitCode: null, feedback }]);
  expect(report.outcome).toBe("error");
});

it("reports copy exceptions without attributing fault detection", async () => {
  vi.mocked(withIsolatedFixture).mockRejectedValue("copy unavailable");
  const report = await runCheckValidation(manifest(), { baseDir: "/fixtures" });
  expect(report.control).toEqual([{ check: "check", status: "error", exitCode: null, feedback: "copy unavailable" }]);
  expect(runCheckCommand).not.toHaveBeenCalled();
});

it("does not start commands after cancellation while a fixture is copied", async () => {
  const ac = new AbortController();
  vi.mocked(withIsolatedFixture).mockImplementation(async (_dir, _label, fn) => { ac.abort(); return fn("/copy"); });
  const report = await runCheckValidation(manifest(), { baseDir: "/fixtures", signal: ac.signal });
  expect(report.control).toEqual([{ check: "check", status: "error", exitCode: null, feedback: "aborted" }]);
  expect(runCheckCommand).not.toHaveBeenCalled();
});

it("marks every pending check as aborted without making copies", async () => {
  const m = manifest();
  m.checks.push({ ...m.checks[0]!, id: "second" });
  const report = await runCheckValidation(m, { baseDir: "/fixtures", signal: AbortSignal.abort() });
  expect(report.control).toEqual(["check", "second"].map(check => ({ check, status: "error", exitCode: null, feedback: "aborted" })));
  expect(withIsolatedFixture).not.toHaveBeenCalled();
});
