/**
 * Exact-string / boundary kills for command + experiment evaluators.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandEvaluator } from "../src/evaluators/command";
import { experimentEvaluator } from "../src/evaluators/experiment";
import { silentLogger } from "../src/core/logger";
import type { EvaluationContext } from "../src/evaluators/types";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "mut-eval-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function ctx(options: Record<string, unknown>, signal?: AbortSignal): EvaluationContext {
  return { runId: "r", iteration: 0, workdir, options, signal, log: silentLogger };
}

describe("mut: commandEvaluator", () => {
  it("has exact type and description", () => {
    expect(commandEvaluator.type).toBe("command");
    expect(commandEvaluator.description).toBe(
      "Run a shell command; pass on the expected exit code (and optional score threshold).",
    );
  });

  it("preflight notes wrap the command in backticks and fail with joined issues", async () => {
    const ok = await commandEvaluator.preflight!({ workdir, options: { command: "npm test" } });
    expect(ok.ok).toBe(true);
    expect(ok.notes).toEqual(["command: `npm test`"]);

    const bad = await commandEvaluator.preflight!({ workdir, options: { command: "", timeoutMs: -1 } });
    expect(bad.ok).toBe(false);
    const msg = bad.errors![0]!;
    expect(msg.startsWith("command evaluator: ")).toBe(true);
    expect(msg).toContain("; ");
  });

  it("returns exact could-not-run feedback on abort", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "echo x" }, AbortSignal.abort()));
    expect(out.ok).toBe(false);
    expect(out.passed).toBe(false);
    expect(out.feedback).toBe("Could not run `echo x`: aborted before start");
    expect(out.error).toBe("aborted before start");
  });

  it("formats exit labels, checkmarks, and score notes exactly", async () => {
    const pass = await commandEvaluator.evaluate(ctx({ command: "echo 'score: 9'", scoreRegex: "score: ([0-9.]+)" }));
    expect(pass.passed).toBe(true);
    expect(pass.feedback).toContain("`echo 'score: 9'` → exit 0 ✓");
    expect(pass.feedback).toContain("score: 9");

    const failExit = await commandEvaluator.evaluate(ctx({ command: "echo nope && exit 1" }));
    expect(failExit.passed).toBe(false);
    expect(failExit.feedback).toContain(" → exit 1 ✗");
    expect(failExit.feedback).toContain("output:");
    expect(failExit.feedback).toContain("nope");

    // scoreGte miss
    const low = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 0.2'", scoreRegex: "score: ([0-9.]+)", scoreGte: 0.8 }),
    );
    expect(low.passed).toBe(false);
    expect(low.feedback).toContain("score 0.2 < required 0.8");

    // scoreLte miss
    const high = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 9'", scoreRegex: "score: ([0-9.]+)", scoreLte: 5 }),
    );
    expect(high.passed).toBe(false);
    expect(high.feedback).toContain("score 9 > allowed 5");

    // missing score when thresholds set
    const missing = await commandEvaluator.evaluate(
      ctx({ command: "echo none", scoreRegex: "score: ([0-9.]+)", scoreGte: 1 }),
    );
    expect(missing.passed).toBe(false);
    expect(missing.feedback).toContain("expected a score but the scoreRegex matched nothing");
  });

  it("scoreGte uses strict < and scoreLte uses strict > (boundary equals pass)", async () => {
    const gteEq = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 5'", scoreRegex: "score: ([0-9.]+)", scoreGte: 5 }),
    );
    expect(gteEq.passed).toBe(true);

    const lteEq = await commandEvaluator.evaluate(
      ctx({ command: "echo 'score: 5'", scoreRegex: "score: ([0-9.]+)", scoreLte: 5 }),
    );
    expect(lteEq.passed).toBe(true);
  });

  it("TIMED OUT label and (no output) placeholder", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "sleep 5", timeoutMs: 50 }));
    expect(out.passed).toBe(false);
    expect(out.feedback).toContain("TIMED OUT");
    // sleep produces no output → (no output) after trim
    expect(out.feedback).toMatch(/output:\n\(no output\)|TIMED OUT/);
  });

  it("defaults expectExitCode to 0 and feedbackChars to 3000", async () => {
    const out = await commandEvaluator.evaluate(ctx({ command: "exit 0" }));
    expect(out.passed).toBe(true);
    // custom expectExitCode
    const custom = await commandEvaluator.evaluate(ctx({ command: "exit 7", expectExitCode: 7 }));
    expect(custom.passed).toBe(true);
    const wrong = await commandEvaluator.evaluate(ctx({ command: "exit 7", expectExitCode: 0 }));
    expect(wrong.passed).toBe(false);
  });

  it("invalid scoreRegex does not throw; score stays undefined", async () => {
    const out = await commandEvaluator.evaluate(
      ctx({ command: "echo hi", scoreRegex: "(unclosed", scoreGte: 1 }),
    );
    expect(out.passed).toBe(false);
    expect(out.score).toBeUndefined();
    expect(out.feedback).toContain("scoreRegex matched nothing");
  });
});

describe("mut: experimentEvaluator", () => {
  it("has exact type and description", () => {
    expect(experimentEvaluator.type).toBe("experiment");
    expect(experimentEvaluator.description).toBe(
      "Read a numeric metric (from a command's JSON output or a file) and compare to thresholds/baseline.",
    );
  });

  it("preflight notes the metric and rejects missing sources with exact refine message", async () => {
    const ok = await experimentEvaluator.preflight!({
      workdir,
      options: { metric: "x", metricsFile: "m.json" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.notes).toEqual(["experiment metric: x"]);

    const bad = await experimentEvaluator.preflight!({ workdir, options: { metric: "x" } });
    expect(bad.ok).toBe(false);
    expect(bad.errors![0]).toContain("experiment evaluator needs either `command` or `metricsFile`");
  });

  it("reads metricsFile and applies min/max/baseline with exact feedback strings", async () => {
    writeFileSync(path.join(workdir, "m.json"), JSON.stringify({ variantB: { conversionRate: 0.12 } }));
    const pass = await experimentEvaluator.evaluate(
      ctx({
        metricsFile: "m.json",
        metric: "variantB.conversionRate",
        minValue: 0.1,
        maxValue: 0.2,
        baseline: 0.1,
        direction: "increase",
        minDelta: 0.01,
      }),
    );
    expect(pass.passed).toBe(true);
    expect(pass.score).toBe(0.12);
    expect(pass.feedback).toContain("variantB.conversionRate = 0.12 ✓");
    expect(pass.feedback).toContain("improved by 0.0200 over baseline 0.1");

    const low = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "m.json", metric: "variantB.conversionRate", minValue: 0.5 }),
    );
    expect(low.passed).toBe(false);
    expect(low.feedback).toContain("value 0.12 < minValue 0.5");
    expect(low.feedback).toContain("✗");

    const high = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "m.json", metric: "variantB.conversionRate", maxValue: 0.05 }),
    );
    expect(high.passed).toBe(false);
    expect(high.feedback).toContain("value 0.12 > maxValue 0.05");
  });

  it("direction decrease treats negative delta as improvement", async () => {
    writeFileSync(path.join(workdir, "m.json"), JSON.stringify({ p95: 80 }));
    const out = await experimentEvaluator.evaluate(
      ctx({
        metricsFile: "m.json",
        metric: "p95",
        baseline: 100,
        direction: "decrease",
        minDelta: 10,
      }),
    );
    expect(out.passed).toBe(true);
    expect(out.feedback).toContain("improved by 20.0000 over baseline 100");

    const notEnough = await experimentEvaluator.evaluate(
      ctx({
        metricsFile: "m.json",
        metric: "p95",
        baseline: 100,
        direction: "decrease",
        minDelta: 50,
      }),
    );
    expect(notEnough.passed).toBe(false);
    expect(notEnough.feedback).toContain("improvement 20.0000 (decrease) over baseline 100 < required 50");
  });

  it("defaults direction to increase and minDelta to 0", async () => {
    writeFileSync(path.join(workdir, "m.json"), JSON.stringify({ v: 5 }));
    // equal to baseline with default minDelta 0 → improved by 0 → passes (< required is false when equal)
    const eq = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "m.json", metric: "v", baseline: 5 }),
    );
    expect(eq.passed).toBe(true);
    expect(eq.feedback).toContain("improved by 0.0000 over baseline 5");

    // decrease from baseline fails under default increase direction
    writeFileSync(path.join(workdir, "m2.json"), JSON.stringify({ v: 4 }));
    const down = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "m2.json", metric: "v", baseline: 5, minDelta: 0.01 }),
    );
    expect(down.passed).toBe(false);
  });

  it("command path: non-zero exit and abort have exact messages", async () => {
    const fail = await experimentEvaluator.evaluate(
      ctx({ command: "echo bad && exit 2", metric: "x" }),
    );
    expect(fail.ok).toBe(false);
    expect(fail.feedback).toMatch(/^Metrics command failed \(exit 2\):/);
    expect(fail.error).toBe("metrics command exit 2");

    const abort = await experimentEvaluator.evaluate(
      ctx({ command: "echo {}", metric: "x" }, AbortSignal.abort()),
    );
    expect(abort.ok).toBe(false);
    expect(abort.feedback).toBe("Could not run metrics command: aborted before start");
  });

  it("metricsFile missing, invalid JSON, and missing metric messages are exact", async () => {
    const missing = await experimentEvaluator.evaluate(ctx({ metricsFile: "nope.json", metric: "x" }));
    expect(missing.ok).toBe(false);
    expect(missing.feedback).toMatch(/^Could not read metrics file "nope.json":/);

    writeFileSync(path.join(workdir, "bad.json"), "not-json{");
    const badJson = await experimentEvaluator.evaluate(ctx({ metricsFile: "bad.json", metric: "x" }));
    expect(badJson.ok).toBe(false);
    expect(badJson.feedback).toMatch(/^Metrics payload was not valid JSON:/);

    writeFileSync(path.join(workdir, "ok.json"), JSON.stringify({ a: { b: "nope" } }));
    const nonNum = await experimentEvaluator.evaluate(ctx({ metricsFile: "ok.json", metric: "a.b" }));
    expect(nonNum.ok).toBe(false);
    expect(nonNum.feedback).toBe('Metric "a.b" was not found or not numeric in the payload.');
    expect(nonNum.error).toBe("metric missing/non-numeric");

    const absent = await experimentEvaluator.evaluate(ctx({ metricsFile: "ok.json", metric: "a.c.d" }));
    expect(absent.ok).toBe(false);
    expect(absent.feedback).toContain('Metric "a.c.d"');
  });

  it("getPath walks dotted keys and coerces numeric strings", async () => {
    writeFileSync(path.join(workdir, "m.json"), JSON.stringify({ a: { b: { c: "3.5" } } }));
    const out = await experimentEvaluator.evaluate(
      ctx({ metricsFile: "m.json", metric: "a.b.c", minValue: 3 }),
    );
    expect(out.passed).toBe(true);
    expect(out.score).toBe(3.5);
  });

  it("command success path parses stdout JSON", async () => {
    const out = await experimentEvaluator.evaluate(
      ctx({ command: "echo '{\"n\": 42}'", metric: "n", minValue: 40 }),
    );
    expect(out.passed).toBe(true);
    expect(out.score).toBe(42);
    expect(out.feedback).toContain("n = 42 ✓");
  });
});
