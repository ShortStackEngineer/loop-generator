import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import type { AgentDriver } from "../src/drivers/types";

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-engine-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

describe("LoopEngine", () => {
  it("converges: fails iteration 0, passes after the agent fixes it", async () => {
    const spec = parseSpec({
      name: "converge",
      requirements: "write 42 to answer.txt",
      driver: {
        uses: "mock",
        options: {
          steps: [{ files: { "answer.txt": "wrong" } }, { files: { "answer.txt": "42" } }],
        },
      },
      evaluators: [
        { uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } },
      ],
      success: { type: "all-pass" },
      limits: { maxIterations: 5 },
    });

    const report = await engine().run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.iterations).toHaveLength(2); // failed once, then passed
    expect(report.iterations[0]!.satisfied).toBe(false);
    expect(report.iterations[1]!.satisfied).toBe(true);
    expect(readFileSync(path.join(workdir, "answer.txt"), "utf8")).toBe("42");
  });

  it("stops at maxIterations when it never converges", async () => {
    const spec = parseSpec({
      name: "never",
      requirements: "impossible",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "nope" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 3 },
    });

    const report = await engine().run(spec, { baseDir: workdir });

    expect(report.success).toBe(false);
    expect(report.outcome).toBe("max-iterations");
    expect(report.iterations).toHaveLength(3);
  });

  it("fails fast on an unknown driver", async () => {
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "does-not-exist" },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(false);
    expect(report.reason).toContain("Unknown driver");
  });

  it("honors a score-based success criterion via the experiment evaluator", async () => {
    const spec = parseSpec({
      name: "metric",
      requirements: "emit a good metric",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "metrics.json": JSON.stringify({ value: 0.9 }) } }] },
      },
      evaluators: [
        { uses: "experiment", as: "metric", options: { metricsFile: "metrics.json", metric: "value", minValue: 0.5 } },
      ],
      success: { type: "score", evaluator: "metric", gte: 0.8 },
      limits: { maxIterations: 2 },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.iterations[0]!.evaluations[0]!.score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
describe("diff-in-feedback (roadmap #1)", () => {
  it("feeds the agent a labeled diff of what it changed last iteration (git-enabled)", async () => {
    initGitRepo(workdir);

    const prompts: string[] = [];
    const capturing: AgentDriver = {
      name: "capture",
      async run(inv) {
        prompts.push(inv.prompt);
        writeFileSync(path.join(inv.workdir, "answer.txt"), inv.iteration === 0 ? "wrong" : "42");
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(capturing);

    const spec = parseSpec({
      name: "diff-feedback",
      requirements: "write 42 to answer.txt",
      driver: { uses: "capture" },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 3 },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    // The 2nd iteration's prompt (built from iteration 0's feedback) carries the diff.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).not.toContain("Changes you made last iteration"); // nothing changed yet
    expect(prompts[1]).toContain("Changes you made last iteration");
    expect(prompts[1]).toContain("answer.txt");
    expect(prompts[1]).toContain("```diff");
  });

  it("does not attach a diff when git change detection is unavailable", async () => {
    const prompts: string[] = [];
    const capturing: AgentDriver = {
      name: "capture-nogit",
      async run(inv) {
        prompts.push(inv.prompt);
        writeFileSync(path.join(inv.workdir, "answer.txt"), inv.iteration === 0 ? "wrong" : "42");
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(capturing);

    const spec = parseSpec({
      name: "diff-nogit",
      requirements: "write 42",
      driver: { uses: "capture-nogit" },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 3 },
    });
    await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).not.toContain("Changes you made last iteration"); // no git → no patch
  });
});

// ---------------------------------------------------------------------------
describe("off-git trust hole (roadmap #2)", () => {
  it("attaches a persistent warning when it relies on driver-reported changes", async () => {
    // Plain temp dir (not a git repo) → change detection falls back to the driver.
    const spec = parseSpec({
      name: "offgit",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 1 },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/git change detection is unavailable/);
  });

  it("flags a vacuous success off-git when the driver reports no changes", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42"); // check already passes
    const spec = parseSpec({
      name: "offgit-vacuous",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ summary: "did nothing" }] } }, // no files → no changes
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 1 },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.iterations[0]!.changed).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/driver reported no file changes/);
  });
});

// ---------------------------------------------------------------------------
describe("budget ceiling (roadmap #5)", () => {
  const budgetSpec = (limits: Record<string, unknown>) =>
    parseSpec({
      name: "budget",
      requirements: "x",
      driver: { uses: "pricey" },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 10, ...limits },
    });

  it("stops with budget-exceeded when cumulative cost passes maxCostUsd", async () => {
    const pricey: AgentDriver = {
      name: "pricey",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "nope"); // never converges
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"], usage: { costUsd: 0.5 } };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(pricey);
    const report = await new LoopEngine(regs, silentLogger).run(budgetSpec({ maxCostUsd: 0.7 }), {
      baseDir: workdir,
    });
    expect(report.outcome).toBe("budget-exceeded");
    expect(report.success).toBe(false);
    expect(report.iterations).toHaveLength(2); // $0.5 ok, then $1.0 > $0.7 → stop
    expect(report.totalUsage.costUsd).toBeCloseTo(1.0);
    expect(report.reason).toMatch(/cost budget exceeded/);
  });

  it("stops with budget-exceeded when cumulative tokens pass maxTokens", async () => {
    const chatty: AgentDriver = {
      name: "pricey",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "nope");
        return {
          ok: true,
          stopReason: "completed",
          changedFiles: ["answer.txt"],
          usage: { inputTokens: 400, outputTokens: 200 },
        };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(chatty);
    const report = await new LoopEngine(regs, silentLogger).run(budgetSpec({ maxTokens: 1000 }), {
      baseDir: workdir,
    });
    expect(report.outcome).toBe("budget-exceeded");
    expect(report.iterations).toHaveLength(2); // 600 tok ok, then 1200 > 1000 → stop
    expect(report.reason).toMatch(/token budget exceeded/);
  });

  it("does not penalize a satisfied iteration that went over budget", async () => {
    const pricey: AgentDriver = {
      name: "pricey",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42"); // satisfies immediately
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"], usage: { costUsd: 5 } };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(pricey);
    const report = await new LoopEngine(regs, silentLogger).run(budgetSpec({ maxCostUsd: 0.01 }), {
      baseDir: workdir,
    });
    expect(report.outcome).toBe("success"); // green wins; only further spend is capped
    expect(report.success).toBe(true);
  });

  it("never trips a budget when the driver reports no usage (mock)", async () => {
    const spec = parseSpec({
      name: "budget-nousage",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "nope" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, maxCostUsd: 0.0001, maxTokens: 1 },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("max-iterations"); // no usage → budget can't fire
  });
});
