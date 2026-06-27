import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateCriteria, type SuccessCriteria } from "../src/core/criteria";
import { buildFeedback } from "../src/core/feedback";
import { commandEvaluator } from "../src/evaluators/command";
import { experimentEvaluator } from "../src/evaluators/experiment";
import { snapshotTree, diffTrees } from "../src/core/workspace";
import { parseSpec } from "../src/core/spec";
import { generateSpec, specToYaml } from "../src/generate";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { mockDriver } from "../src/drivers/mock";
import { silentLogger } from "../src/core/logger";
import type { EvaluationContext, EvaluationResult } from "../src/evaluators/types";
import type { AgentDriver } from "../src/drivers/types";

let workdir: string;
beforeEach(() => (workdir = mkdtempSync(path.join(tmpdir(), "loopgen-bound-"))));
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

const res = (name: string, passed: boolean, score?: number): EvaluationResult => ({
  name,
  type: "command",
  ok: true,
  passed,
  score,
  feedback: "",
  durationMs: 1,
});
const ctx = (options: Record<string, unknown>): EvaluationContext => ({
  runId: "r",
  iteration: 0,
  workdir,
  options,
  log: silentLogger,
});

describe("criteria boundaries", () => {
  it("score gte/lte/eq are inclusive at the boundary", () => {
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 0.8 }, [res("m", true, 0.8)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 0.8 }, [res("m", true, 0.79)]).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "score", evaluator: "m", lte: 0.8 }, [res("m", true, 0.8)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", lte: 0.8 }, [res("m", true, 0.81)]).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "score", evaluator: "m", eq: 5 }, [res("m", true, 5)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", eq: 5 }, [res("m", true, 6)]).satisfied).toBe(false);
  });

  it("score with both bounds requires the value to be inside the range", () => {
    const c = { type: "score", evaluator: "m", gte: 1, lte: 3 } as const;
    expect(evaluateCriteria(c, [res("m", true, 2)]).satisfied).toBe(true);
    expect(evaluateCriteria(c, [res("m", true, 4)]).satisfied).toBe(false);
  });

  it("all requires every child; any requires one; not inverts", () => {
    const pass: SuccessCriteria = { type: "pass", evaluators: ["a"] };
    const fail: SuccessCriteria = { type: "pass", evaluators: ["b"] };
    const results = [res("a", true), res("b", false)];
    expect(evaluateCriteria({ type: "all", of: [pass, fail] }, results).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "all", of: [pass, pass] }, results).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "any", of: [fail, pass] }, results).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "any", of: [fail, fail] }, results).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "not", of: pass }, results).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "not", of: fail }, results).satisfied).toBe(true);
  });

  it("all-pass names the failing checks", () => {
    const v = evaluateCriteria({ type: "all-pass" }, [res("a", true), res("b", false)]);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toContain("b");
    expect(v.reason).not.toContain("a:");
  });
});

describe("command evaluator boundaries", () => {
  it("score threshold is inclusive and exit code must match exactly", async () => {
    const opt = (gte: number) => ({ command: "echo 'score: 0.80'", scoreRegex: "score: ([0-9.]+)", scoreGte: gte });
    expect((await commandEvaluator.evaluate(ctx(opt(0.8)))).passed).toBe(true);
    expect((await commandEvaluator.evaluate(ctx(opt(0.81)))).passed).toBe(false);

    const r = await commandEvaluator.evaluate(ctx({ command: "exit 4", expectExitCode: 4 }));
    expect(r.passed).toBe(true);
    expect(r.details?.exitCode).toBe(4);
    expect((await commandEvaluator.evaluate(ctx({ command: "exit 5", expectExitCode: 4 }))).passed).toBe(false);
  });

  it("scoreLte upper bound is inclusive", async () => {
    const opt = (lte: number) => ({ command: "echo 'score: 0.80'", scoreRegex: "score: ([0-9.]+)", scoreLte: lte });
    expect((await commandEvaluator.evaluate(ctx(opt(0.8)))).passed).toBe(true);
    expect((await commandEvaluator.evaluate(ctx(opt(0.79)))).passed).toBe(false);
  });
});

describe("experiment evaluator boundaries", () => {
  const write = (o: unknown) => writeFileSync(path.join(workdir, "m.json"), JSON.stringify(o));

  it("minValue/maxValue are inclusive", async () => {
    write({ v: 0.5 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", minValue: 0.5 }))).passed).toBe(true);
    write({ v: 0.49 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", minValue: 0.5 }))).passed).toBe(false);
    write({ v: 5 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", maxValue: 5 }))).passed).toBe(true);
    write({ v: 6 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", maxValue: 5 }))).passed).toBe(false);
  });

  it("minDelta is inclusive for both directions", async () => {
    // Integer values to avoid float boundary fuzz.
    write({ v: 10 });
    expect(
      (await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", baseline: 8, direction: "increase", minDelta: 2 }))).passed,
    ).toBe(true);
    write({ v: 9 });
    expect(
      (await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", baseline: 8, direction: "increase", minDelta: 2 }))).passed,
    ).toBe(false);
    write({ v: 100 });
    expect(
      (await experimentEvaluator.evaluate(ctx({ metricsFile: "m.json", metric: "v", baseline: 120, direction: "decrease", minDelta: 20 }))).passed,
    ).toBe(true);
  });
});

describe("buildFeedback structure", () => {
  it("orders failing before passing and marks states", () => {
    const fb = buildFeedback([res("p", true, 9), { ...res("f", false, 2), ok: false, error: "ERR" }], {
      satisfied: false,
      reason: "x",
    });
    expect(fb.text.indexOf("Failing checks")).toBeLessThan(fb.text.indexOf("Passing checks"));
    expect(fb.text).toContain("could not run");
    expect(fb.text).toContain("error: ERR");
    expect(fb.text).toContain("score: 2");
    expect(fb.text).toContain("NOT YET");
  });

  it("reports PASS overall when satisfied", () => {
    const fb = buildFeedback([res("a", true)], { satisfied: true, reason: "all good" });
    expect(fb.passed).toBe(true);
    expect(fb.text).toContain("PASS");
  });
});

describe("workspace snapshot stability", () => {
  it("equal snapshots for an unchanged tree; diff respects custom ignore", () => {
    const git = (args: string[]) => spawnSync("git", args, { cwd: workdir });
    git(["init"]);
    writeFileSync(path.join(workdir, "a.txt"), "1");
    const s1 = snapshotTree(workdir)!;
    expect(snapshotTree(workdir)).toBe(s1); // identical tree → identical hash
    writeFileSync(path.join(workdir, "skip.me"), "noise");
    const s2 = snapshotTree(workdir)!;
    expect(diffTrees(workdir, s1, s2, ["skip.me"]).changed).toBe(false);
    expect(diffTrees(workdir, s1, s2, []).changed).toBe(true);
    expect(diffTrees(workdir, s1, s1, []).changed).toBe(false);
  });
});

describe("spec defaults", () => {
  it("applies the documented defaults", () => {
    const spec = parseSpec({ name: "x", requirements: "r", driver: { uses: "mock" }, evaluators: [{ uses: "command" }] });
    expect(spec.limits.maxIterations).toBe(5);
    expect(spec.limits.baseline).toBe(false);
    expect(spec.workspace.snapshot).toBe("none");
    expect(spec.workspace.ignore).toEqual([]);
    expect(spec.evaluators[0]!.options).toEqual({});
  });
});

describe("generateSpec defaults", () => {
  it("defaults driver, iterations, and workspace dir", () => {
    const spec = generateSpec({ name: "G", taskType: "function", language: "typescript", requirements: "x" });
    expect(spec.driver.uses).toBe("claude-agent-sdk");
    expect(spec.limits.maxIterations).toBe(5);
    expect(spec.workspace.dir).toBe(".");
    expect(specToYaml(spec)).toContain("version: 1");
  });
});

describe("mock driver clamps to the last step", () => {
  it("applies the final step on out-of-range iterations", async () => {
    const r = await mockDriver.run({
      runId: "r",
      iteration: 5,
      workdir,
      prompt: "p",
      options: { steps: [{ files: { "a.txt": "first" } }, { files: { "a.txt": "last" } }] },
      log: silentLogger,
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(workdir, "a.txt"), "utf8")).toBe("last");
  });
});

describe("engine accumulates usage and runs a baseline", () => {
  it("sums usage across iterations and records baseline evaluations", async () => {
    const usageBot: AgentDriver = {
      name: "usage-bot",
      async run() {
        return { ok: true, stopReason: "completed", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1, turns: 1 } };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(usageBot);

    const spec = parseSpec({
      name: "x",
      requirements: "r",
      driver: { uses: "usage-bot" },
      evaluators: [{ uses: "command", as: "c", options: { command: "exit 1" } }],
      limits: { maxIterations: 3, baseline: true },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });

    expect(report.outcome).toBe("max-iterations");
    expect(report.reason).toContain("3");
    expect(report.totalUsage).toEqual({ inputTokens: 3, outputTokens: 6, costUsd: expect.closeTo(0.3, 5), turns: 3 });
    expect(report.baseline?.evaluations).toHaveLength(1);
  });
});
