import { z } from "zod";
import type { EvaluationResult } from "../evaluators/types";

/**
 * Declarative success criteria evaluated against the latest evaluator results.
 * Composable so a spec can express "tests pass AND p95 latency < 200ms".
 */
export type SuccessCriteria =
  | { type: "all-pass" }
  | { type: "pass"; evaluators: string[] }
  | { type: "score"; evaluator: string; gte?: number; lte?: number; eq?: number }
  | { type: "all"; of: SuccessCriteria[] }
  | { type: "any"; of: SuccessCriteria[] }
  | { type: "not"; of: SuccessCriteria };

export const successCriteriaSchema: z.ZodType<SuccessCriteria> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("all-pass") }),
    z.object({ type: z.literal("pass"), evaluators: z.array(z.string()).min(1) }),
    z.object({
      type: z.literal("score"),
      evaluator: z.string(),
      gte: z.number().optional(),
      lte: z.number().optional(),
      eq: z.number().optional(),
    }),
    z.object({ type: z.literal("all"), of: z.array(successCriteriaSchema).min(1) }),
    z.object({ type: z.literal("any"), of: z.array(successCriteriaSchema).min(1) }),
    z.object({ type: z.literal("not"), of: successCriteriaSchema }),
  ]),
);

export interface CriteriaVerdict {
  satisfied: boolean;
  reason: string;
}

function byName(results: EvaluationResult[], name: string): EvaluationResult | undefined {
  return results.find((r) => r.name === name);
}

export function evaluateCriteria(
  criteria: SuccessCriteria,
  results: EvaluationResult[],
): CriteriaVerdict {
  switch (criteria.type) {
    case "all-pass": {
      if (results.length === 0) {
        return { satisfied: false, reason: "no evaluators were configured" };
      }
      const failing = results.filter((r) => !r.passed);
      return failing.length === 0
        ? { satisfied: true, reason: "all checks passed" }
        : {
            satisfied: false,
            reason: `failing: ${failing.map((r) => r.name).join(", ")}`,
          };
    }
    case "pass": {
      const failing: string[] = [];
      const missing: string[] = [];
      for (const name of criteria.evaluators) {
        const r = byName(results, name);
        if (!r) missing.push(name);
        else if (!r.passed) failing.push(name);
      }
      if (missing.length) {
        return { satisfied: false, reason: `unknown evaluator(s): ${missing.join(", ")}` };
      }
      return failing.length === 0
        ? { satisfied: true, reason: `required checks passed: ${criteria.evaluators.join(", ")}` }
        : { satisfied: false, reason: `failing: ${failing.join(", ")}` };
    }
    case "score": {
      const r = byName(results, criteria.evaluator);
      if (!r) return { satisfied: false, reason: `unknown evaluator: ${criteria.evaluator}` };
      if (typeof r.score !== "number") {
        return { satisfied: false, reason: `${criteria.evaluator} produced no score` };
      }
      const checks: string[] = [];
      let ok = true;
      if (criteria.gte !== undefined) {
        ok = ok && r.score >= criteria.gte;
        checks.push(`>= ${criteria.gte}`);
      }
      if (criteria.lte !== undefined) {
        ok = ok && r.score <= criteria.lte;
        checks.push(`<= ${criteria.lte}`);
      }
      if (criteria.eq !== undefined) {
        ok = ok && r.score === criteria.eq;
        checks.push(`== ${criteria.eq}`);
      }
      return {
        satisfied: ok,
        reason: `${criteria.evaluator}=${r.score} (need ${checks.join(" and ") || "any"})`,
      };
    }
    case "all": {
      const verdicts = criteria.of.map((c) => evaluateCriteria(c, results));
      const failed = verdicts.filter((v) => !v.satisfied);
      return failed.length === 0
        ? { satisfied: true, reason: "all sub-criteria satisfied" }
        : { satisfied: false, reason: failed.map((v) => v.reason).join("; ") };
    }
    case "any": {
      const verdicts = criteria.of.map((c) => evaluateCriteria(c, results));
      const passed = verdicts.find((v) => v.satisfied);
      return passed
        ? { satisfied: true, reason: passed.reason }
        : { satisfied: false, reason: `none of: ${verdicts.map((v) => v.reason).join(" | ")}` };
    }
    case "not": {
      const inner = evaluateCriteria(criteria.of, results);
      return {
        satisfied: !inner.satisfied,
        reason: `not(${inner.reason})`,
      };
    }
  }
}

/** Human description of a criteria tree, used in prompts and reports. */
export function describeCriteria(c: SuccessCriteria): string {
  switch (c.type) {
    case "all-pass":
      return "all checks pass";
    case "pass":
      return `these checks pass: ${c.evaluators.join(", ")}`;
    case "score": {
      const parts: string[] = [];
      if (c.gte !== undefined) parts.push(`>= ${c.gte}`);
      if (c.lte !== undefined) parts.push(`<= ${c.lte}`);
      if (c.eq !== undefined) parts.push(`== ${c.eq}`);
      return `${c.evaluator} score ${parts.join(" and ") || "is produced"}`;
    }
    case "all":
      return c.of.map(describeCriteria).join(" AND ");
    case "any":
      return `(${c.of.map(describeCriteria).join(" OR ")})`;
    case "not":
      return `NOT (${describeCriteria(c.of)})`;
  }
}
