import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheckValidationGate } from "../src/check-validation/gate";
import type { SpecEvaluator } from "../src/core/spec";

let root: string;
const command = "node check.cjs";
const timeoutMs = 1000;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cv-gate-"));
  mkdirSync(path.join(root, "good"));
  mkdirSync(path.join(root, "bad"));
  writeFileSync(path.join(root, "good", "check.cjs"), "process.exit(0)");
  writeFileSync(path.join(root, "bad", "check.cjs"), "process.exit(10)");
  save();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rawManifest(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: "gate-contract",
    goal: "Deliver the requested outcome",
    assumptions: ["Supplied examples"],
    gaps: ["Production unobserved"],
    checks: [{ id: "correct", command, timeoutMs, rejectExitCodes: [10] }],
    claims: [{ id: "claim", description: "Correct result", checks: ["correct"] }],
    control: { dir: "good" },
    counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
    ...over,
  };
}

function save(m: unknown = rawManifest()) {
  writeFileSync(path.join(root, "checks.json"), JSON.stringify(m));
}

function evaluators(over: Partial<SpecEvaluator> = {}, options: Record<string, unknown> = {}): SpecEvaluator[] {
  return [
    {
      uses: "command",
      as: "correct",
      ...over,
      options: { command, timeoutMs, ...options },
    },
  ];
}

async function gate(
  over: { manifest?: string; evaluators?: SpecEvaluator[]; signal?: AbortSignal } = {},
) {
  return runCheckValidationGate({
    manifest: over.manifest ?? "checks.json",
    baseDir: root,
    evaluators: over.evaluators ?? evaluators(),
    signal: over.signal,
  });
}

describe("runCheckValidationGate", () => {
  it("validates matching command evaluators and attaches provenance", async () => {
    const result = await gate();
    expect(result.status).toBe("ok");
    expect(result.report?.outcome).toBe("validated");
    expect(result.report?.gaps).toEqual(["Production unobserved"]);
    expect(result.inputs?.manifest).toBe(path.join(root, "checks.json"));
    expect(result.inventory?.hashes[path.join(root, "checks.json")]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.unmappedEvaluators).toEqual([]);
    expect(result.unmappedWarning).toBeUndefined();
  });

  it("lists evaluators the manifest does not cover", async () => {
    const extra: SpecEvaluator = { uses: "command", as: "extra", options: { command: "true" } };
    const result = await gate({ evaluators: [...evaluators(), extra] });
    expect(result.status).toBe("ok");
    expect(result.unmappedEvaluators).toEqual(["extra"]);
    expect(result.unmappedWarning).toMatch(/extra/);
  });

  it("aborts before reading anything when the signal is already aborted", async () => {
    const result = await gate({ signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: "aborted", reason: "run aborted", unmappedEvaluators: [] });
    expect(result.report).toBeUndefined();
    expect(result.inventory).toBeUndefined();
  });

  it("fails closed on a missing or malformed manifest without running checks", async () => {
    const marker = path.join(root, "ran");
    writeFileSync(
      path.join(root, "good", "check.cjs"),
      `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
    );
    rmSync(path.join(root, "checks.json"));
    const missing = await gate();
    expect(missing.status).toBe("failed");
    expect(missing.reason).toMatch(/cannot read manifest/);
    expect(existsSync(marker)).toBe(false);

    save({ version: 42 });
    const malformed = await gate();
    expect(malformed.status).toBe("failed");
    expect(malformed.reason).toMatch(/check validation:/);
    expect(malformed.report).toBeUndefined();
  });

  it("fails on unreadable YAML and on a directory supplied as the manifest", async () => {
    writeFileSync(path.join(root, "checks.json"), ":\n:");
    const yaml = await gate();
    expect(yaml.status).toBe("failed");
    expect(yaml.reason).toMatch(/check validation:/);

    const asDir = await gate({ manifest: "good" });
    expect(asDir.status).toBe("failed");
    expect(asDir.reason).toMatch(/cannot read manifest/);
  });

  it("rejects incompatible bindings before any check command runs", async () => {
    const marker = path.join(root, "should-not-run");
    writeFileSync(
      path.join(root, "good", "check.cjs"),
      `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
    );
    const result = await gate({ evaluators: evaluators({ as: "different" }) });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/not bound to a command evaluator/);
    expect(existsSync(marker)).toBe(false);
    expect(result.unmappedEvaluators).toEqual(["different"]);
  });

  it("fails inventory capture when a fixture root is a symlink", async () => {
    rmSync(path.join(root, "bad"), { recursive: true });
    symlinkSync(path.join(root, "good"), path.join(root, "bad"));
    const result = await gate();
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/fixture directory is a symlink/);
  });

  it("aborts after a successful bind when the signal flips", async () => {
    let n = 0;
    const signal = { get aborted() { return ++n >= 2; } } as AbortSignal;
    const result = await gate({ signal });
    expect(result.status).toBe("aborted");
    expect(result.inventory).toBeUndefined();
    expect(result.unmappedEvaluators).toEqual([]);
  });

  it("aborts after inventory capture without running checks", async () => {
    const marker = path.join(root, "ran");
    writeFileSync(
      path.join(root, "good", "check.cjs"),
      `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
    );
    let n = 0;
    const signal = { get aborted() { return ++n >= 3; } } as AbortSignal;
    const result = await gate({ signal });
    expect(result.status).toBe("aborted");
    expect(result.inventory?.manifest).toBe(path.join(root, "checks.json"));
    expect(existsSync(marker)).toBe(false);
  });

  it("returns aborted with a report when cancelled during a long check", async () => {
    writeFileSync(path.join(root, "good", "check.cjs"), "setTimeout(()=>{},10000)");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 80);
    try {
      const result = await gate({ signal: ac.signal });
      expect(result.status).toBe("aborted");
      expect(result.report).toBeDefined();
      expect(result.inventory).toBeDefined();
    } finally {
      clearTimeout(timer);
    }
  });

  it("fails when the control example does not pass", async () => {
    writeFileSync(path.join(root, "good", "check.cjs"), "process.exit(10)");
    const result = await gate();
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/control check "correct"/);
    expect(result.report?.outcome).toBe("error");
  });

  it("fails when a counterexample escapes", async () => {
    writeFileSync(path.join(root, "bad", "check.cjs"), "process.exit(0)");
    const result = await gate();
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/counterexample "fault" escaped/);
    expect(result.report?.outcome).toBe("gaps");
  });

  it("fails when a counterexample errors", async () => {
    writeFileSync(path.join(root, "bad", "check.cjs"), "throw new Error('harness crash')");
    const result = await gate();
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/counterexample "fault" errored/);
    expect(result.report?.outcome).toBe("error");
  });

  it("fails when a claim has no mapped counterexample", async () => {
    const m = rawManifest();
    (m.claims as object[]).push({ id: "uncovered", description: "No faulty fixture", checks: ["correct"] });
    save(m);
    const result = await gate();
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/claim "uncovered" has no mapped counterexample/);
    expect(result.report?.outcome).toBe("gaps");
  });

  it("reports tampering when a check rewrites its own source fixture", async () => {
    const file = path.join(root, "good", "check.cjs");
    writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(file)}, 'process.exit(0)')`);
    const result = await gate();
    expect(result.status).toBe("tampered");
    expect(result.reason).toMatch(/modified/);
    expect(result.report?.outcome).toBe("validated");
    expect(result.inputs?.manifest).toBe(path.join(root, "checks.json"));
  });

  it("resolves an absolute manifest path", async () => {
    const result = await gate({ manifest: path.join(root, "checks.json") });
    expect(result.status).toBe("ok");
  });
});
