import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import type { AgentDriver } from "../src/drivers/types";

function initGitRepo(dir: string): void {
  const run = (args: string[]): void => {
    spawnSync("git", args, { cwd: dir });
  };
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-trust-"));
  initGitRepo(workdir);
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const checkAnswer = { uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } };

describe("trustworthy success (P1)", () => {
  it("flags a no-op success: criteria pass but the agent changed nothing", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42"); // already satisfies the check
    const spec = parseSpec({
      name: "noop",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ summary: "did nothing" }] } },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.iterations[0]!.changed).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/changed no files/i);
    expect(report.changedFiles).toEqual([]);
  });

  it("detects real changes and does not flag a no-op", async () => {
    const spec = parseSpec({
      name: "real",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.iterations[0]!.changed).toBe(true);
    expect(report.changedFiles).toContain("answer.txt");
    expect(report.warnings).toEqual([]);
  });

  it("flags baseline checks that already pass before any agent work", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42");
    const spec = parseSpec({
      name: "baseline",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "other.txt": "stuff" } }] } },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1, baseline: true },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, { baseDir: workdir });

    expect(report.baseline?.satisfied).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/already pass/i);
  });

  it("treats artifact-only churn (logs/db) as a no-op", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42"); // check already passes
    const spec = parseSpec({
      name: "artifact-noop",
      requirements: "x",
      // Agent only writes a log file — the kind of churn running a test suite produces.
      driver: { uses: "mock", options: { steps: [{ files: { "log/test.log": "ran tests\n" } }] } },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.iterations[0]!.changed).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/changed no files/i);
  });

  it("counts source changes but excludes artifacts from the diff", async () => {
    const spec = parseSpec({
      name: "mixed",
      requirements: "x",
      driver: {
        uses: "mock",
        options: {
          steps: [{ files: { "answer.txt": "42", "log/test.log": "noise", "tmp/cache/x": "c" } }],
        },
      },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.iterations[0]!.changed).toBe(true);
    expect(report.changedFiles).toContain("answer.txt");
    expect(report.changedFiles).not.toContain("log/test.log");
    expect(report.changedFiles!.some((f) => f.startsWith("tmp/"))).toBe(false);
    expect(report.warnings).toEqual([]);
  });

  it("flags spec tampering and keeps the spec out of the work diff", async () => {
    // The risky setup: the loop spec lives inside the workspace.
    const specPath = path.join(workdir, "task.loop.yaml");
    writeFileSync(specPath, "name: original\n");
    const spec = parseSpec({
      name: "spec-tamper",
      requirements: "x",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "answer.txt": "42", "task.loop.yaml": "name: tampered\n" } }] },
      },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, {
      baseDir: workdir,
      specFile: specPath,
    });

    expect(report.success).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/modified the loop spec/i);
    expect(report.changedFiles).toContain("answer.txt");
    expect(report.changedFiles).not.toContain("task.loop.yaml");
  });

  it("does not flag tampering when the spec is left untouched", async () => {
    const specPath = path.join(workdir, "task.loop.yaml");
    writeFileSync(specPath, "name: original\n");
    const spec = parseSpec({
      name: "spec-clean",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(createDefaultRegistries(), silentLogger).run(spec, {
      baseDir: workdir,
      specFile: specPath,
    });

    expect(report.success).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("warns when the agent did not complete (max_turns) but checks pass", async () => {
    const incompleteDriver: AgentDriver = {
      name: "incomplete",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
        return { ok: true, stopReason: "max_turns", summary: "ran out of turns", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(incompleteDriver);

    const spec = parseSpec({
      name: "incomplete",
      requirements: "x",
      driver: { uses: "incomplete" },
      evaluators: [checkAnswer],
      limits: { maxIterations: 1 },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/did not complete|max_turns/i);
  });
});
