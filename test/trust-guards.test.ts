import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";

let workdir: string;
beforeEach(() => (workdir = mkdtempSync(path.join(tmpdir(), "loopgen-trust-"))));
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

const engine = () => new LoopEngine(createDefaultRegistries(), silentLogger);

/** A spec whose single check passes regardless of any agent work (vacuous). */
const vacuousSpec = (over: Record<string, unknown> = {}) =>
  parseSpec({
    name: "vac",
    requirements: "x",
    driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
    evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
    limits: { maxIterations: 2, ...(over as object) },
  });

// ---------------------------------------------------------------------------
describe("schema: baseline + specGuard", () => {
  it("defaults baseline=false and specGuard=warn", () => {
    const s = parseSpec({ name: "d", requirements: "x", driver: { uses: "mock" } });
    expect(s.limits.baseline).toBe(false);
    expect(s.limits.specGuard).toBe("warn");
  });
  it("accepts baseline:'strict' and specGuard values", () => {
    const s = parseSpec({
      name: "d",
      requirements: "x",
      driver: { uses: "mock" },
      limits: { baseline: "strict", specGuard: "error" },
    });
    expect(s.limits.baseline).toBe("strict");
    expect(s.limits.specGuard).toBe("error");
  });
  it("rejects an invalid specGuard", () => {
    expect(() =>
      parseSpec({ name: "d", requirements: "x", driver: { uses: "mock" }, limits: { specGuard: "loud" } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("enforceable baseline (#1)", () => {
  it("strict: a passing baseline fails the run before the agent runs", async () => {
    const report = await engine().run(vacuousSpec({ baseline: "strict" }), { baseDir: workdir });
    expect(report.outcome).toBe("baseline-vacuous");
    expect(report.success).toBe(false);
    expect(report.iterations).toHaveLength(0); // agent never invoked
    expect(report.baseline?.satisfied).toBe(true);
  });

  it("non-strict (true): a passing baseline only warns, run still succeeds", async () => {
    const report = await engine().run(vacuousSpec({ baseline: true }), { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.warnings.join("\n")).toMatch(/already pass BEFORE/);
  });

  it("strict: a baseline that legitimately fails does not block the run", async () => {
    const spec = parseSpec({
      name: "real",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { baseline: "strict", maxIterations: 2 },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.baseline?.satisfied).toBe(false); // feature absent → baseline red
    expect(report.success).toBe(true); // agent built it → green
    expect(report.outcome).toBe("success");
  });

  it("--strict override (opts.baseline) wins over a spec that has baseline off", async () => {
    const report = await engine().run(vacuousSpec({ baseline: false }), {
      baseDir: workdir,
      baseline: "strict",
    });
    expect(report.outcome).toBe("baseline-vacuous");
  });
});

// ---------------------------------------------------------------------------
describe("spec-tamper policy (#2)", () => {
  // A spec whose agent overwrites the on-disk spec file during the run.
  const tamperSpec = (specGuard?: string) =>
    parseSpec({
      name: "tamper",
      requirements: "x",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "my.loop.yaml": "tampered: true\n", "x.txt": "1" } }] },
      },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
      limits: { maxIterations: 2, ...(specGuard ? { specGuard } : {}) },
    });

  const runWithSpecFile = (specGuard?: string) => {
    const specFile = path.join(workdir, "my.loop.yaml");
    writeFileSync(specFile, "original: true\n");
    return engine().run(tamperSpec(specGuard), { baseDir: workdir, specFile });
  };

  it("error: tampering fails the run even though the checks pass", async () => {
    const report = await runWithSpecFile("error");
    expect(report.outcome).toBe("spec-tampered");
    expect(report.success).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/modified the loop spec file/);
  });

  it("warn (default): tampering is surfaced but the run still succeeds", async () => {
    const report = await runWithSpecFile();
    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.warnings.join("\n")).toMatch(/modified the loop spec file/);
  });

  it("off: the spec file is not watched, no tamper warning", async () => {
    const report = await runWithSpecFile("off");
    expect(report.success).toBe(true);
    expect(report.warnings.join("\n")).not.toMatch(/modified the loop spec file/);
  });

  it("error: tampering on a failing (max-iterations) run stays red, with the warning", async () => {
    // Tamper must not *upgrade* an already-red outcome — it only blocks a green.
    const specFile = path.join(workdir, "my.loop.yaml");
    writeFileSync(specFile, "original: true\n");
    const spec = parseSpec({
      name: "tamper-red",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "my.loop.yaml": "tampered\n", "x.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "exit 1" } }], // never passes
      limits: { maxIterations: 1, specGuard: "error" },
    });
    const report = await engine().run(spec, { baseDir: workdir, specFile });
    expect(report.outcome).toBe("max-iterations");
    expect(report.success).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/modified the loop spec file/);
  });

  it("off: the spec edit is still excluded from the work diff (no-op guard intact)", async () => {
    // #6 regression: the diff-exclusion is independent of the watch, so editing
    // the spec with the guard off must not count as work / defeat the no-op guard.
    execSync("git init -q", { cwd: workdir });
    const specFile = path.join(workdir, "my.loop.yaml");
    writeFileSync(specFile, "original: true\n");
    const spec = parseSpec({
      name: "off-excl",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "my.loop.yaml": "tampered\n" } }] } }, // edits ONLY the spec
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
      limits: { maxIterations: 1, specGuard: "off" },
    });
    const report = await engine().run(spec, { baseDir: workdir, specFile });
    expect(report.success).toBe(true);
    expect(report.changedFiles ?? []).not.toContain("my.loop.yaml"); // excluded from the diff
    expect(report.warnings.join("\n")).toMatch(/changed no files/); // no-op guard still fires
  });
});
