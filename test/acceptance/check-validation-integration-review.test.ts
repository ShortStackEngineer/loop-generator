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

it("rejects duplicate evaluator aliases before running validation", async () => {
  const s = raw(); s.evaluators.push({ ...s.evaluators[0] });
  const report = await run(s, { skipPreflight: true });
  expect(report.outcome).toBe("preflight-failed"); expect(calls).toBe(0);
});
it("detects a validation command changing its own source fixture", async () => {
  const file = path.join(root, "contracts/good/check.cjs");
  writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(file)}, 'process.exit(0)')`);
  const report = await run();
  expect(report.outcome).toBe("evaluator-tampered"); expect(calls).toBe(0);
});
it("detects baseline tampering before a vacuous-baseline return", async () => {
  const file = path.join(root, "contracts/bad/check.cjs");
  writeFileSync(path.join(root, "work/check.cjs"), `require('fs').writeFileSync(${JSON.stringify(file)}, 'process.exit(0)')`);
  const report = await run(raw(), { baseline: "strict" });
  expect(report.outcome).toBe("evaluator-tampered"); expect(calls).toBe(0);
  expect(report.checkValidation.outcome).toBe("validated");
});
it.each(["empty-directory", "root-symlink"])("detects %s fixture changes", async (kind) => {
  const original = edit;
  edit = () => {
    original();
    if (kind === "empty-directory") mkdirSync(path.join(root, "contracts/bad/new-dir"));
    else { rmSync(path.join(root, "contracts/bad"), { recursive: true }); symlinkSync(path.join(root, "contracts/good"), path.join(root, "contracts/bad")); }
  };
  const report = await run(); expect(report.outcome).toBe("evaluator-tampered");
});
it("retains validation evidence after an agent abort", async () => {
  const ac = new AbortController(); edit = () => ac.abort();
  const report = await run(raw(), { signal: ac.signal });
  expect(report.outcome).toBe("aborted"); expect(report.checkValidation.outcome).toBe("validated");
});
it.each(["exhausted", "aborted"])("checks input integrity on %s terminal paths", async (kind) => {
  const ac = new AbortController();
  edit = () => { writeFileSync(path.join(root, "contracts/bad/check.cjs"), "process.exit(0)"); if (kind === "aborted") ac.abort(); };
  const report = await run(raw(), { signal: ac.signal });
  expect(report.outcome).toBe("evaluator-tampered"); expect(report.checkValidation.outcome).toBe("validated");
});
it.each(["cwd", "env", "expectExitCode"])("rejects null %s before executing validation", async (key) => {
  const s = raw(); s.evaluators[0].options[key] = null;
  const marker = path.join(root, "null-must-not-run");
  writeFileSync(path.join(root, "contracts/good/check.cjs"), `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  const report = await run(s, { skipPreflight: true });
  expect(report.outcome).toBe("preflight-failed"); expect(calls).toBe(0); expect(existsSync(marker)).toBe(false);
});
