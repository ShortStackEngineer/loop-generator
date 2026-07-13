/**
 * Thin adapter over the REAL engine criteria logic (src/core/criteria.ts),
 * imported via the @src alias. The only adaptation: demo results don't carry
 * durationMs, so we stamp a zero before handing them to the engine function.
 */
import { evaluateCriteria as realEvaluateCriteria, describeCriteria } from "@src/core/criteria";
import type { SuccessCriteria } from "@src/core/criteria";
import type { EvaluationResult } from "@src/evaluators/types";
import type { EvalResult, Verdict } from "./types";

export function toEvaluationResults(results: EvalResult[]): EvaluationResult[] {
  return results.map((r) => ({ ...r, durationMs: 0 }));
}

export function evaluateCriteria(criteria: SuccessCriteria, results: EvalResult[]): Verdict {
  return realEvaluateCriteria(criteria, toEvaluationResults(results));
}

export { describeCriteria };
