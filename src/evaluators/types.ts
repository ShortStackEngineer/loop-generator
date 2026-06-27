import type { Logger } from "../core/logger";
import type { PreflightResult } from "../core/preflight";

/**
 * An Evaluator is a "feedback tool": it measures the current state of the
 * workspace and reports (a) whether it passes its own bar and (b) human/agent
 * readable feedback that gets handed to the agent on the next iteration.
 *
 * The generic `command` evaluator already covers tests, linters, type checkers,
 * and benchmarks (anything with a CLI + exit code). Implement this interface
 * when you need something a shell command can't express (e.g. parsing a metrics
 * payload, calling an external analytics API, statistical A/B comparison).
 */
export interface EvaluationContext {
  runId: string;
  /** 0-based iteration index. */
  iteration: number;
  /** Absolute path to the workspace the agent is editing. */
  workdir: string;
  /** Instance options from the loop spec (`evaluators[].options`). */
  options: Record<string, unknown>;
  /** Aborts when the iteration times out or the run is cancelled. */
  signal?: AbortSignal;
  log: Logger;
}

/** What an evaluator returns; the engine stamps `name`/`type`/`durationMs`. */
export interface EvaluationOutcome {
  /** Did this check meet its bar? Drives success criteria. */
  passed: boolean;
  /** False if the evaluator could not run at all (distinct from "ran and failed"). */
  ok?: boolean;
  /** Optional numeric measurement (latency, coverage %, conversion rate, ...). */
  score?: number;
  /** Feedback text shown to the agent next iteration. Make it actionable. */
  feedback: string;
  /** Structured detail for reports/tooling. */
  details?: Record<string, unknown>;
  /** Error message when `ok === false`. */
  error?: string;
}

export interface EvaluationResult extends EvaluationOutcome {
  /** Instance name: the spec's `as`, falling back to `uses`. */
  name: string;
  /** The evaluator type (`uses`). */
  type: string;
  ok: boolean;
  durationMs: number;
}

export interface Evaluator {
  /** Stable identifier referenced by `evaluators[].uses` in a spec. */
  readonly type: string;
  readonly description?: string;
  /** Optional pre-run check (binary present? metrics file exists?). */
  preflight?(ctx: { workdir: string; options: Record<string, unknown> }): Promise<PreflightResult>;
  evaluate(ctx: EvaluationContext): Promise<EvaluationOutcome>;
}
