/**
 * Thin adapter over the REAL engine feedback renderer (src/core/feedback.ts).
 * What the course shows as "the agent's next prompt" is produced by the same
 * function the engine runs.
 */
import { buildFeedback as realBuildFeedback } from "@src/core/feedback";
import type { FeedbackDiff } from "@src/core/feedback";
import type { FeedbackSummary } from "@src/drivers/types";
import { toEvaluationResults } from "./criteria";
import type { EvalResult, Verdict } from "./types";

export type { FeedbackSummary, FeedbackDiff };

export function buildFeedback(
  results: EvalResult[],
  verdict: Verdict,
  opts: { maxCharsPerCheck?: number; diff?: FeedbackDiff } = {},
): FeedbackSummary {
  return realBuildFeedback(toEvaluationResults(results), verdict, opts);
}
