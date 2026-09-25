import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { LoopEngine, parseSpec, createDefaultRegistries, challengePacketPath } from "../../src/index";
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
function readPacket(): { outcome: string; runId: string; requirements: string } {
  const file = challengePacketPath(path.join(root, "work"));
  expect(existsSync(file)).toBe(true);
  return JSON.parse(readFileSync(file, "utf8"));
}

it("keeps spec-tamper precedence when an unsatisfied iteration also changes validation inputs", async () => {
  const specFile = path.join(root, "work/run.loop.json");
  writeFileSync(specFile, JSON.stringify(raw()));
  edit = () => { writeFileSync(specFile, "changed"); writeFileSync(path.join(root, "contracts/bad/check.cjs"), "changed"); };
  const report = await run(raw(), { specFile });
  expect(report.outcome).toBe("spec-tampered"); expect(report.success).toBe(false);
});
it("does not change legacy final-turn cancellation behavior without opt-in", async () => {
  const s = raw(); delete s.checkValidation;
  const ac = new AbortController(); edit = () => ac.abort();
  const report = await run(s, { signal: ac.signal });
  expect(report.outcome).toBe("max-iterations");
  expect(report).not.toHaveProperty("checkValidation");
});
it("preserves callback error propagation for specs without opt-in", async () => {
  const s = raw(); delete s.checkValidation;
  await expect(run(s, { onIteration: () => { throw new Error("callback failed"); } })).rejects.toThrow("callback failed");
});
it("returns validation evidence and writes a challenge packet when driver preflight throws", async () => {
  const registries = createDefaultRegistries();
  registries.drivers.register({
    name: "integration-test",
    async preflight() { throw new Error("preflight exploded"); },
    async run() { calls++; throw new Error("agent must not run"); },
  });
  const report: any = await new LoopEngine(registries, silentLogger).run(parseSpec(raw()), { baseDir: root });
  expect(calls).toBe(0);
  expect(report.outcome).toBe("error");
  expect(report.error).toBe("preflight exploded");
  expect(report.success).toBe(false);
  expect(report.checkValidation.outcome).toBe("validated");
  expect(report.challengePacket).toBe(challengePacketPath(path.join(root, "work")));
  const packet = readPacket();
  expect(packet.outcome).toBe("error");
  expect(packet.runId).toBe(report.runId);
  expect(packet.requirements).toBe("Fix check.cjs");
});
it("returns validation evidence and writes a challenge packet when task validation throws", async () => {
  const registries = createDefaultRegistries();
  registries.drivers.register({
    name: "integration-test",
    async run() { calls++; throw new Error("agent must not run"); },
  });
  registries.tasks.register({
    type: "explodes",
    recommendedEvaluators: () => [],
    buildSystemPrompt: () => "",
    buildInitialPrompt: () => "",
    buildIterationPrompt: () => "",
    validate() { throw new Error("task validation exploded"); },
  });
  const spec = raw();
  spec.task = { type: "explodes" };
  const report: any = await new LoopEngine(registries, silentLogger).run(parseSpec(spec), { baseDir: root });
  expect(calls).toBe(0);
  expect(report.outcome).toBe("error");
  expect(report.error).toBe("task validation exploded");
  expect(report.checkValidation.outcome).toBe("validated");
  expect(readPacket().outcome).toBe("error");
  expect(readPacket().runId).toBe(report.runId);
});
it("re-verifies validation inputs when preflight changes fixtures and then throws", async () => {
  const registries = createDefaultRegistries();
  registries.drivers.register({
    name: "integration-test",
    async preflight() {
      writeFileSync(path.join(root, "contracts/bad/check.cjs"), "changed");
      throw new Error("preflight exploded");
    },
    async run() { calls++; throw new Error("agent must not run"); },
  });
  const report: any = await new LoopEngine(registries, silentLogger).run(parseSpec(raw()), { baseDir: root });
  expect(calls).toBe(0);
  expect(report.outcome).toBe("evaluator-tampered");
  expect(report.success).toBe(false);
  expect(report.checkValidation.outcome).toBe("validated");
  expect(readPacket().outcome).toBe("evaluator-tampered");
});
it("keeps spec-tamper precedence when onIteration throws after the spec and validation fixtures change", async () => {
  const specFile = path.join(root, "work/run.loop.json");
  writeFileSync(specFile, JSON.stringify(raw()));
  edit = () => {
    writeFileSync(specFile, "changed");
    writeFileSync(path.join(root, "contracts/bad/check.cjs"), "changed");
  };
  const report = await run(raw(), { specFile, onIteration: () => { throw new Error("callback failed"); } });
  expect(report.outcome).toBe("spec-tampered");
  expect(report.success).toBe(false);
  expect(report.reason).toMatch(/specGuard: error/);
  expect(report.error).toBeUndefined();
  expect(report.checkValidation.outcome).toBe("validated");
  expect(readPacket().outcome).toBe("spec-tampered");
  expect(readPacket().runId).toBe(report.runId);
});
it("returns an error report and validation evidence when onIteration throws without tampering", async () => {
  const report = await run(raw(), { onIteration: () => { throw new Error("callback failed"); } });
  expect(report.outcome).toBe("error");
  expect(report.error).toBe("callback failed");
  expect(report.checkValidation.outcome).toBe("validated");
  expect(readPacket().outcome).toBe("error");
});
it("still propagates a preflight exception when check validation is not opted in", async () => {
  const registries = createDefaultRegistries();
  registries.drivers.register({
    name: "integration-test",
    async preflight() { throw new Error("preflight exploded"); },
    async run() { throw new Error("agent must not run"); },
  });
  const spec = raw();
  delete spec.checkValidation;
  await expect(new LoopEngine(registries, silentLogger).run(parseSpec(spec), { baseDir: root })).rejects.toThrow("preflight exploded");
  expect(existsSync(challengePacketPath(path.join(root, "work")))).toBe(false);
});
