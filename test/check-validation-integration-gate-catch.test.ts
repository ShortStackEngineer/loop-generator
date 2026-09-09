import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheckValidationGate } from "../src/check-validation/gate";
import { runCheckValidation } from "../src/check-validation/runner";
import type { CheckValidationReport } from "../src/check-validation/aggregate";

const race = vi.hoisted(() => ({
  file: "",
  replacement: "",
  armed: false,
  originalRun: undefined as ((...args: never[]) => unknown) | undefined,
}));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      if (race.armed && String(args[0]) === race.file) {
        race.armed = false;
        fs.writeFileSync(race.file, race.replacement);
      }
      return result;
    },
  };
});

vi.mock("../src/check-validation/runner", async (original) => {
  const actual = await original<typeof import("../src/check-validation/runner")>();
  race.originalRun = actual.runCheckValidation as (typeof race)["originalRun"];
  return {
    ...actual,
    runCheckValidation: vi.fn(actual.runCheckValidation),
  };
});

let root = "";
afterEach(() => {
  race.armed = false;
  vi.mocked(runCheckValidation).mockReset();
  if (race.originalRun) {
    vi.mocked(runCheckValidation).mockImplementation(race.originalRun as typeof runCheckValidation);
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const command = "node check.cjs";

function seed() {
  root = mkdtempSync(path.join(tmpdir(), "cv-gate-catch-"));
  for (const dir of ["good", "bad"]) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, "good", "check.cjs"), "process.exit(0)");
  writeFileSync(path.join(root, "bad", "check.cjs"), "process.exit(10)");
  const manifest = {
    version: 1,
    name: "race",
    goal: "original goal",
    checks: [{ id: "c", command, timeoutMs: 1000, rejectExitCodes: [10] }],
    claims: [{ id: "claim", description: "correct", checks: ["c"] }],
    control: { dir: "good" },
    counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
  };
  race.file = path.join(root, "checks.json");
  writeFileSync(race.file, JSON.stringify(manifest));
  return manifest;
}

it("does not attach the hash of a different manifest than the one parsed", async () => {
  const manifest = seed();
  const marker = path.join(root, "executed");
  writeFileSync(
    path.join(root, "good", "check.cjs"),
    `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
  );
  race.replacement = JSON.stringify({ ...manifest, goal: "changed goal" });
  race.armed = true;
  const result = await runCheckValidationGate({
    manifest: race.file,
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 }, guard: [] }],
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toMatch(/changed between parse and inventory capture/);
  expect(result.report).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
});

it("treats a thrown abort from the runner as an aborted gate", async () => {
  seed();
  const ac = new AbortController();
  vi.mocked(runCheckValidation).mockImplementation(async () => {
    ac.abort();
    throw new Error("aborted by runner");
  });
  const result = await runCheckValidationGate({
    manifest: "checks.json",
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 } }],
    signal: ac.signal,
  });
  expect(result.status).toBe("aborted");
  expect(result.inventory).toBeDefined();
});

it("treats an abort-shaped throw as aborted even when the signal is still live", async () => {
  seed();
  vi.mocked(runCheckValidation).mockRejectedValue(new Error("AbortError: run cancelled"));
  const result = await runCheckValidationGate({
    manifest: "checks.json",
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 } }],
  });
  expect(result.status).toBe("aborted");
  expect(result.reason).toBe("run aborted");
});

it("surfaces a non-abort runner throw as a failed gate with provenance", async () => {
  seed();
  vi.mocked(runCheckValidation).mockRejectedValue(new Error("disk exploded"));
  const result = await runCheckValidationGate({
    manifest: "checks.json",
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 } }],
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toBe("check validation: disk exploded");
  expect(result.inventory).toBeDefined();
});

it("stringifies a non-Error runner throw", async () => {
  seed();
  vi.mocked(runCheckValidation).mockRejectedValue("nope");
  const result = await runCheckValidationGate({
    manifest: "checks.json",
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 } }],
  });
  expect(result.status).toBe("failed");
  expect(result.reason).toBe("check validation: nope");
});

it("returns aborted with the completed report when the signal flips after the runner", async () => {
  seed();
  const ac = new AbortController();
  const report: CheckValidationReport = {
    name: "race",
    goal: "original goal",
    assumptions: [],
    gaps: [],
    outcome: "validated",
    control: [],
    counterexamples: [],
    claims: [],
  };
  vi.mocked(runCheckValidation).mockImplementation(async () => {
    ac.abort();
    return report;
  });
  const result = await runCheckValidationGate({
    manifest: "checks.json",
    baseDir: root,
    evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 } }],
    signal: ac.signal,
  });
  expect(result.status).toBe("aborted");
  expect(result.report).toEqual(report);
});
