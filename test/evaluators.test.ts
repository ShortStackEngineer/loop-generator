import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandEvaluator } from "../src/evaluators/command";
import { experimentEvaluator } from "../src/evaluators/experiment";
import { silentLogger } from "../src/core/logger";
import type { EvaluationContext } from "../src/evaluators/types";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-eval-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function ctx(options: Record<string, unknown>, signal?: AbortSignal): EvaluationContext {
  return { runId: "r", iteration: 0, workdir, options, signal, log: silentLogger };
}

describe("command evaluator", () => {
  it("passes on the expected exit code", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "exit 0" }));
    expect(out.passed).toBe(true);
    expect(out.ok).toBe(true);
  });

  it("fails and includes output on non-zero exit", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "echo boom-detail && exit 1" }));
    expect(out.passed).toBe(false);
    expect(out.feedback).toContain("boom-detail");
  });

  it("honors a custom expected exit code", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "exit 2", expectExitCode: 2 }));
    expect(out.passed).toBe(true);
  });

  it("extracts a score and applies thresholds", async () => {
    const pass = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 0.91'", scoreRegex: "score: ([0-9.]+)", scoreGte: 0.8 }),
    );
    expect(pass.passed).toBe(true);
    expect(pass.score).toBeCloseTo(0.91);

    const fail = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 0.50'", scoreRegex: "score: ([0-9.]+)", scoreGte: 0.8 }),
    );
    expect(fail.passed).toBe(false);
    expect(fail.feedback).toMatch(/< required/);
  });

  it("fails when a score is required but the regex matches nothing", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "echo nope", scoreRegex: "score: ([0-9.]+)", scoreGte: 1 }));
    expect(out.passed).toBe(false);
    expect(out.feedback).toMatch(/matched nothing/);
  });

  it("runs in a subdirectory", async () => {
    mkdirSync(path.join(workdir, "sub"));
    writeFileSync(path.join(workdir, "sub", "marker"), "x");
    const out = await commandEvaluator.evaluate(ctx({ command: "test -f marker", cwd: "sub" }));
    expect(out.passed).toBe(true);
  });

  it("returns ok:false when the run cannot start (aborted)", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "echo x" }, AbortSignal.abort()));
    expect(out.ok).toBe(false);
    expect(out.passed).toBe(false);
  });

  it("preflight rejects a missing command", async () => {
    const pf = await commandEvaluator.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(false);
  });

  it("records structured details and an exit label in feedback", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "exit 1" }));
    expect(out.details).toMatchObject({ command: "exit 1", exitCode: 1, timedOut: false });
    expect(out.feedback).toContain("exit 1");
    expect(out.feedback).toContain("`exit 1`");
  });
});

describe("experiment evaluator", () => {
  function writeMetrics(obj: unknown): void {
    writeFileSync(path.join(workdir, "metrics.json"), JSON.stringify(obj));
  }

  it("passes when a metric clears an absolute threshold", async () => {
    writeMetrics({ value: 0.9 });
    const out = await experimentEvaluator.evaluate(ctx({ metricsFile: "metrics.json", metric: "value", minValue: 0.5 }));
    expect(out.passed).toBe(true);
    expect(out.score).toBe(0.9);
  });

  it("fails below minValue and above maxValue", async () => {
    writeMetrics({ value: 0.3 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "metrics.json", metric: "value", minValue: 0.5 }))).passed).toBe(false);
    writeMetrics({ value: 9 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "metrics.json", metric: "value", maxValue: 5 }))).passed).toBe(false);
  });

  it("checks improvement over a baseline (increase and decrease)", async () => {
    writeMetrics({ value: 0.9 });
    const up = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "metrics.json", metric: "value", baseline: 0.8, direction: "increase", minDelta: 0.05 }),
    );
    expect(up.passed).toBe(true);

    writeMetrics({ value: 0.88 });
    const tooSmall = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "metrics.json", metric: "value", baseline: 0.8, direction: "increase", minDelta: 0.1 }),
    );
    expect(tooSmall.passed).toBe(false);

    writeMetrics({ latency: 100 });
    const down = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "metrics.json", metric: "latency", baseline: 130, direction: "decrease", minDelta: 20 }),
    );
    expect(down.passed).toBe(true);
  });

  it("reads a dotted metric path", async () => {
    writeMetrics({ a: { b: 5 } });
    const out = await experimentEvaluator.evaluate(ctx({ metricsFile: "metrics.json", metric: "a.b", minValue: 1 }));
    expect(out.score).toBe(5);
  });

  it("reads metrics from a command's stdout", async () => {
    const out = await experimentEvaluator.evaluate(ctx({ command: `echo '{"value": 0.7}'`, metric: "value", minValue: 0.5 }));
    expect(out.passed).toBe(true);
    expect(out.score).toBe(0.7);
  });

  it("errors on a failing metrics command", async () => {
    const out = await experimentEvaluator.evaluate(ctx({ command: "exit 1", metric: "value" }));
    expect(out.ok).toBe(false);
  });

  it("errors on a missing metric, invalid JSON, and a missing file", async () => {
    writeMetrics({ other: 1 });
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "metrics.json", metric: "value" }))).ok).toBe(false);

    writeFileSync(path.join(workdir, "bad.json"), "not json");
    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "bad.json", metric: "value" }))).ok).toBe(false);

    expect((await experimentEvaluator.evaluate(ctx({ metricsFile: "missing.json", metric: "value" }))).ok).toBe(false);
  });

  it("preflight rejects options with neither command nor metricsFile", async () => {
    const pf = await experimentEvaluator.preflight!({ workdir, options: { metric: "value" } });
    expect(pf.ok).toBe(false);
  });

  it("exposes metric/baseline in details and explains the gap", async () => {
    writeMetrics({ value: 0.9 });
    const out = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "metrics.json", metric: "value", baseline: 0.8, direction: "increase", minDelta: 0.05 }),
    );
    expect(out.details).toMatchObject({ metric: "value", value: 0.9, baseline: 0.8 });
    expect(out.feedback).toContain("improved by");
  });
});
