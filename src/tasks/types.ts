import type { FeedbackSummary } from "../drivers/types";
import type { LoopSpec, SpecEvaluator } from "../core/spec";

/**
 * A TaskType encapsulates the domain knowledge for a category of work: how to
 * frame the agent (system prompt), how to state the task (initial prompt), how
 * to push it forward after feedback (iteration prompt), and which evaluators the
 * generator should scaffold by default.
 *
 * Task types are advisory: the engine falls back to a generic task type if a
 * spec references an unregistered one, so adding a category never breaks runs.
 */
export interface TaskType {
  /** Identifier referenced by `task.type` in a spec. */
  readonly type: string;
  readonly description?: string;
  /** Evaluators the generator proposes for this category + stack. */
  recommendedEvaluators(spec: LoopSpec): SpecEvaluator[];
  buildSystemPrompt(spec: LoopSpec): string;
  buildInitialPrompt(spec: LoopSpec): string;
  buildIterationPrompt(spec: LoopSpec, feedback: FeedbackSummary): string;
  /** Optional extra validation; return human-readable errors (empty = ok). */
  validate?(spec: LoopSpec): string[];
}
