import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LoopEngine, parseSpec, createDefaultRegistries } from "../../src/index";
import { silentLogger } from "../../src/core/logger";

let root: string;
let calls: number;
let edit: () => void;
const command = "node check.cjs";
const timeoutMs = 1000;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "integration-contract-")); calls = 0;
  for (const dir of ["contracts/good", "contracts/bad", "work"]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, "contracts/good/check.cjs"), "process.exit(0)");
  writeFileSync(path.join(root, "contracts/bad/check.cjs"), "process.exit(10)");
  writeFileSync(path.join(root, "work/check.cjs"), "process.exit(10)");
  edit = () => writeFileSync(path.join(root, "work/check.cjs"), "process.exit(0)");
  saveManifest();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function manifest() {
  return { version: 1, name: "integration-contract", goal: "Deliver the requested outcome", assumptions: ["Supplied examples"], gaps: ["Production unobserved"],
    checks: [{ id: "correct", command, timeoutMs, rejectExitCodes: [10] }],
    claims: [{ id: "claim", description: "Correct result", checks: ["correct"] }],
    control: { dir: "good" }, counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }] };
}
function saveManifest(m: unknown = manifest()) { writeFileSync(path.join(root, "contracts/acceptance.checks.json"), JSON.stringify(m)); }
function raw(): any {
  return { version: 1, name: "integration", task: { type: "generic" }, stack: { language: "text" }, workspace: { dir: "work" }, requirements: "Fix check.cjs",
    checkValidation: { manifest: "contracts/acceptance.checks.json" }, driver: { uses: "integration-test" },
    evaluators: [{ uses: "command", as: "correct", options: { command, timeoutMs } }], success: { type: "all-pass" }, limits: { maxIterations: 1, baseline: false } };
}
async function run(spec = raw(), opts: Record<string, unknown> = {}): Promise<any> {
  const registries = createDefaultRegistries();
  registries.drivers.register({ name: "integration-test", async run() { calls++; edit(); return { ok: true, summary: "edited", changedFiles: ["check.cjs"], stopReason: "completed" }; } });
  return new LoopEngine(registries, silentLogger).run(parseSpec(spec), { baseDir: root, ...opts });
}

it("validates before agent work and carries the complete evidence and provenance to success", async () => {
  const report = await run();
  expect(report.outcome).toBe("success"); expect(calls).toBe(1);
  expect(report.checkValidation).toMatchObject({ name: "integration-contract", goal: "Deliver the requested outcome", assumptions: ["Supplied examples"], gaps: ["Production unobserved"], outcome: "validated", counterexamples: [{ id: "fault", status: "caught" }] });
  const file = path.join(root, "contracts/acceptance.checks.json");
  expect(report.checkValidationInputs.manifest).toBe(file);
  expect(report.checkValidationInputs.hashes[file]).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
  expect(report.checkValidationInputs.hashes[path.join(root, "contracts/bad/check.cjs")]).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["escaped", "control", "crash", "missing", "malformed", "uncovered"])("blocks %s before any agent invocation", async (kind) => {
  if (kind === "escaped") writeFileSync(path.join(root, "contracts/bad/check.cjs"), "process.exit(0)");
  if (kind === "control") writeFileSync(path.join(root, "contracts/good/check.cjs"), "process.exit(10)");
  if (kind === "crash") writeFileSync(path.join(root, "contracts/bad/check.cjs"), "throw new Error('harness crash')");
  if (kind === "missing") rmSync(path.join(root, "contracts/acceptance.checks.json"));
  if (kind === "malformed") saveManifest({ version: 42 });
  if (kind === "uncovered") { const m = manifest(); m.claims.push({ id: "uncovered", description: "No faulty fixture", checks: ["correct"] }); saveManifest(m); }
  const report = await run();
  expect(report.outcome).toBe("preflight-failed"); expect(report.success).toBe(false); expect(report.iterations).toEqual([]); expect(calls).toBe(0);
  expect(report.reason).toMatch(/check|manifest|validation/i);
  if (!["missing", "malformed"].includes(kind)) expect(report.checkValidation.outcome).toBe(["escaped", "uncovered"].includes(kind) ? "gaps" : "error");
});
it.each(["alias", "command", "timeout", "no-timeout", "cwd", "env", "expected-exit", "score"])("rejects incompatible %s bindings before commands execute", async (kind) => {
  const s = raw(); const evaluator = s.evaluators[0];
  if (kind === "alias") evaluator.as = "different";
  if (kind === "command") evaluator.options.command = "node other.cjs";
  if (kind === "timeout") evaluator.options.timeoutMs = 2000;
  if (kind === "no-timeout") delete evaluator.options.timeoutMs;
  if (kind === "cwd") evaluator.options.cwd = "nested";
  if (kind === "env") evaluator.options.env = { SPECIAL: "different" };
  if (kind === "expected-exit") evaluator.options.expectExitCode = 10;
  if (kind === "score") evaluator.options.scoreRegex = "(.*)";
  const marker = path.join(root, "should-not-run");
  writeFileSync(path.join(root, "contracts/good/check.cjs"), `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  const report = await run(s, { skipPreflight: true });
  expect(report.outcome).toBe("preflight-failed"); expect(calls).toBe(0); expect(existsSync(marker)).toBe(false);
});
it("lists evaluators not covered by validation", async () => {
  const s = raw(); s.evaluators.push({ uses: "command", as: "extra", options: { command: "true" } });
  const report = await run(s);
  expect(report.outcome).toBe("success"); expect(report.checkValidationUnmappedEvaluators).toEqual(["extra"]);
  expect(report.warnings.join(" ")).toMatch(/extra/);
});
it("cannot bypass the gate with skipPreflight or baseline:false", async () => {
  writeFileSync(path.join(root, "contracts/bad/check.cjs"), "process.exit(0)");
  const report = await run(raw(), { skipPreflight: true, baseline: false });
  expect(report.outcome).toBe("preflight-failed"); expect(calls).toBe(0);
});
it("preserves evidence on a vacuous baseline and exhausted iterations", async () => {
  writeFileSync(path.join(root, "work/check.cjs"), "process.exit(0)");
  let report = await run(raw(), { baseline: "strict" });
  expect(report.outcome).toBe("baseline-vacuous"); expect(report.checkValidation.outcome).toBe("validated"); expect(calls).toBe(0);
  writeFileSync(path.join(root, "work/check.cjs"), "process.exit(10)"); edit = () => {};
  report = await run(); expect(report.outcome).toBe("max-iterations"); expect(report.checkValidation.outcome).toBe("validated");
});
it("aborts before validation without invoking commands", async () => {
  const report = await run(raw(), { signal: AbortSignal.abort() });
  expect(report.outcome).toBe("aborted"); expect(calls).toBe(0);
});
it("aborts during validation and never starts the agent", async () => {
  writeFileSync(path.join(root, "contracts/good/check.cjs"), "setTimeout(()=>{},10000)");
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 100);
  try { const report = await run(raw(), { signal: ac.signal }); expect(report.outcome).toBe("aborted"); expect(calls).toBe(0); } finally { clearTimeout(timer); }
});
it.each(["manifest", "delete", "fixture", "symlink", "new-file"])("refuses success after %s input tampering", async (kind) => {
  const original = edit;
  edit = () => {
    original(); const file = path.join(root, "contracts/bad/check.cjs");
    if (kind === "manifest") saveManifest({ ...manifest(), goal: "changed" });
    if (kind === "delete") rmSync(path.join(root, "contracts/acceptance.checks.json"));
    if (kind === "fixture") writeFileSync(file, "process.exit(0)");
    if (kind === "symlink") { rmSync(file); symlinkSync(path.join(root, "contracts/good/check.cjs"), file); }
    if (kind === "new-file") writeFileSync(path.join(root, "contracts/bad/new.txt"), "changed");
  };
  const report = await run(); expect(report.outcome).toBe("evaluator-tampered"); expect(report.success).toBe(false);
  expect(report.checkValidation.outcome).toBe("validated"); expect(report.reason).toMatch(/validation|fixture|manifest/i);
});
it("leaves old specs unchanged and rejects invalid opt-in shapes", async () => {
  const s = raw(); delete s.checkValidation; const report = await run(s);
  expect(report.outcome).toBe("success"); expect(report).not.toHaveProperty("checkValidation");
  for (const value of [null, "file", {}, { manifest: "" }, { manifest: 3 }]) expect(() => parseSpec({ ...s, checkValidation: value })).toThrow();
});
it("exposes validation in the built CLI report and summary", () => {
  const s = raw(); s.driver = { uses: "mock", options: { steps: [{ files: { "check.cjs": "process.exit(0)" } }] } };
  const file = path.join(root, "run.loop.json"); writeFileSync(file, JSON.stringify(s));
  const out = path.join(root, "report.json");
  const result = spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), "run", file, "--report", out], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8")).checkValidation.outcome).toBe("validated");
  expect(result.stdout).toMatch(/check validation.*validated/i);
});
it("propagates the validation gate and evidence through batch execution", async () => {
  const { runBatch } = await import("../../src/batch/runner");
  const { parseBatchManifest } = await import("../../src/batch/manifest");
  const s = raw(); s.driver = { uses: "mock", options: { steps: [{ files: { "check.cjs": "process.exit(0)" } }] } };
  writeFileSync(path.join(root, "contracts/bad/check.cjs"), "process.exit(0)");
  const batch = parseBatchManifest({ items: [{ name: "one", inline: s }] });
  const report = await runBatch(batch, new LoopEngine(createDefaultRegistries(), silentLogger), { baseDir: root, log: silentLogger });
  expect(report.success).toBe(false);
  expect(report.items[0]?.report).toMatchObject({ outcome: "preflight-failed", iterations: [], checkValidation: { outcome: "gaps" } });
  expect(readFileSync(path.join(root, "work/check.cjs"), "utf8")).toBe("process.exit(10)");
});
