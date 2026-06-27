import { describe, it, expect } from "vitest";
import { evaluateCriteria } from "../src/core/criteria";
import type { EvaluationResult } from "../src/evaluators/types";

function result(name: string, passed: boolean, score?: number): EvaluationResult {
  return { name, type: "command", ok: true, passed, score, feedback: "", durationMs: 1 };
}

describe("evaluateCriteria", () => {
  it("all-pass requires every check to pass", () => {
    expect(evaluateCriteria({ type: "all-pass" }, [result("a", true), result("b", true)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "all-pass" }, [result("a", true), result("b", false)]).satisfied).toBe(false);
  });

  it("all-pass with no evaluators is not satisfied", () => {
    expect(evaluateCriteria({ type: "all-pass" }, []).satisfied).toBe(false);
  });

  it("pass checks only named evaluators", () => {
    const results = [result("tests", true), result("lint", false)];
    expect(evaluateCriteria({ type: "pass", evaluators: ["tests"] }, results).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "pass", evaluators: ["tests", "lint"] }, results).satisfied).toBe(false);
  });

  it("score applies numeric thresholds", () => {
    const results = [result("metric", true, 0.42)];
    expect(evaluateCriteria({ type: "score", evaluator: "metric", gte: 0.4 }, results).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "metric", gte: 0.5 }, results).satisfied).toBe(false);
    expect(evaluateCriteria({ type: "score", evaluator: "metric", lte: 0.4 }, results).satisfied).toBe(false);
  });

  it("composes all/any/not", () => {
    const results = [result("tests", true), result("metric", true, 5)];
    expect(
      evaluateCriteria(
        { type: "all", of: [{ type: "pass", evaluators: ["tests"] }, { type: "score", evaluator: "metric", gte: 3 }] },
        results,
      ).satisfied,
    ).toBe(true);
    expect(
      evaluateCriteria(
        { type: "any", of: [{ type: "pass", evaluators: ["missing"] }, { type: "score", evaluator: "metric", gte: 3 }] },
        results,
      ).satisfied,
    ).toBe(true);
    expect(evaluateCriteria({ type: "not", of: { type: "all-pass" } }, results).satisfied).toBe(false);
  });
});
