import type { FeedbackSummary } from "../drivers/types";
import type { EvaluationResult } from "../evaluators/types";
import type { CriteriaVerdict } from "./criteria";

const DEFAULT_MAX_FEEDBACK_CHARS = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(-tail)}`;
}

/**
 * Render evaluator results into a single agent-facing feedback block. Failing
 * checks are listed first (and in full) since that's what the agent must fix;
 * passing checks are summarized so the agent knows not to regress them.
 */
export function buildFeedback(
  results: EvaluationResult[],
  verdict: CriteriaVerdict,
  opts: { maxCharsPerCheck?: number } = {},
): FeedbackSummary {
  const maxPer = opts.maxCharsPerCheck ?? DEFAULT_MAX_FEEDBACK_CHARS;
  const failing = results.filter((r) => !r.passed);
  const passing = results.filter((r) => r.passed);

  const lines: string[] = [];
  lines.push(`Overall: ${verdict.satisfied ? "PASS" : "NOT YET"} — ${verdict.reason}`);

  if (failing.length) {
    lines.push("");
    lines.push("## Failing checks (fix these)");
    for (const r of failing) {
      lines.push("");
      lines.push(`### ${r.name} [${r.type}]${r.ok ? "" : " (could not run)"}`);
      if (typeof r.score === "number") lines.push(`score: ${r.score}`);
      if (r.error) lines.push(`error: ${r.error}`);
      lines.push(truncate(r.feedback.trim() || "(no detail)", maxPer));
    }
  }

  if (passing.length) {
    lines.push("");
    lines.push("## Passing checks (keep these green)");
    for (const r of passing) {
      const score = typeof r.score === "number" ? ` (score ${r.score})` : "";
      lines.push(`- ${r.name} [${r.type}]${score}`);
    }
  }

  return {
    passed: verdict.satisfied,
    reason: verdict.reason,
    text: lines.join("\n"),
    evaluations: results,
  };
}
