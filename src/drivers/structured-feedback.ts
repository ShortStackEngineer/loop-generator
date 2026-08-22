import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { EvaluationResult } from "../evaluators/types";
import type { AgentEvent, FeedbackSummary } from "./types";

/** Marker delimiting the machine-readable block appended by built-in drivers. */
export const STRUCTURED_FEEDBACK_MARKER = "loopgen:structured-feedback:v1";

/** Slim JSON shape drivers pass to agents (omits timing-only fields). */
export interface StructuredFeedbackPayload {
  passed: boolean;
  reason: string;
  evaluations: Array<{
    name: string;
    type: string;
    passed: boolean;
    ok: boolean;
    score?: number;
    feedback: string;
    error?: string;
    details?: Record<string, unknown>;
  }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build the structured payload from {@link FeedbackSummary.evaluations}. */
export function structuredFeedbackPayload(feedback: FeedbackSummary): StructuredFeedbackPayload {
  return {
    passed: feedback.passed,
    reason: feedback.reason,
    evaluations: feedback.evaluations.map((r) => ({
      name: r.name,
      type: r.type,
      passed: r.passed,
      ok: r.ok,
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      feedback: r.feedback,
      ...(r.error ? { error: r.error } : {}),
      ...(r.details ? { details: r.details } : {}),
    })),
  };
}

/**
 * Append a machine-readable evaluator breakdown when {@link FeedbackSummary.evaluations}
 * is populated. Built-in drivers call this so agents (and tests) can consume the
 * structured channel instead of re-parsing {@link FeedbackSummary.text}.
 */
export function augmentPromptWithStructuredFeedback(
  prompt: string,
  feedback: FeedbackSummary | undefined,
): string {
  if (!feedback?.evaluations?.length) return prompt;
  const payload = structuredFeedbackPayload(feedback);
  const block = [
    "",
    `<!-- ${STRUCTURED_FEEDBACK_MARKER} -->`,
    "Structured evaluator results (machine-readable; prefer this block over re-parsing the prose above):",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
  return `${prompt}${block}`;
}

/** Emit a single trajectory event carrying the structured payload for observers. */
export function emitStructuredFeedbackEvents(
  emit: ((event: AgentEvent) => void) | undefined,
  feedback: FeedbackSummary | undefined,
): void {
  if (!emit || !feedback?.evaluations?.length) return;
  emit({
    kind: "model-message",
    text: `[${STRUCTURED_FEEDBACK_MARKER}] ${JSON.stringify(structuredFeedbackPayload(feedback))}`,
  });
}

/**
 * Mock-driver helper: apply `details.files` from failing evaluations
 * (`Record<relativePath, contents>`). Returns whether any file was written.
 */
export function applyStructuredFileFixes(
  evaluations: EvaluationResult[],
  workdir: string,
): { applied: boolean; changedFiles: string[] } {
  const changedFiles: string[] = [];
  for (const ev of evaluations) {
    if (ev.passed || ev.ok === false) continue;
    const files = ev.details?.files;
    if (!isRecord(files)) continue;
    for (const [rel, contents] of Object.entries(files)) {
      if (typeof contents !== "string") continue;
      const abs = path.resolve(workdir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
      changedFiles.push(rel);
    }
  }
  return { applied: changedFiles.length > 0, changedFiles };
}
