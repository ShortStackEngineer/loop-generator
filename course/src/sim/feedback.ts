/**
 * Faithful browser port of src/core/feedback.ts — buildFeedback renders the
 * exact agent-facing feedback block the engine produces after each iteration.
 */
import type { EvalResult, Verdict } from "./types";

const DEFAULT_MAX_FEEDBACK_CHARS = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(-tail)}`;
}

export interface FeedbackDiff {
  files: string[];
  patch?: string | null;
}

export interface FeedbackSummary {
  passed: boolean;
  reason: string;
  text: string;
}

export function buildFeedback(
  results: EvalResult[],
  verdict: Verdict,
  opts: { maxCharsPerCheck?: number; diff?: FeedbackDiff } = {},
): FeedbackSummary {
  const maxPer = opts.maxCharsPerCheck ?? DEFAULT_MAX_FEEDBACK_CHARS;
  const failing = results.filter((r) => !r.passed);
  const passing = results.filter((r) => r.passed);

  const lines: string[] = [];
  lines.push(`Overall: ${verdict.satisfied ? "PASS" : "NOT YET"} — ${verdict.reason}`);

  if (opts.diff && opts.diff.files.length) {
    lines.push("");
    lines.push(`## Changes you made last iteration (${opts.diff.files.length} file(s))`);
    for (const f of opts.diff.files) lines.push(`- ${f}`);
    if (opts.diff.patch) {
      lines.push("");
      lines.push("Diff of your last changes (truncated if large):");
      lines.push("```diff");
      lines.push(opts.diff.patch);
      lines.push("```");
    }
  }

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

  return { passed: verdict.satisfied, reason: verdict.reason, text: lines.join("\n") };
}
