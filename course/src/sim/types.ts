/**
 * Course-side shapes. SuccessCriteria/Verdict come straight from the engine
 * source (via the @src alias) — the course cannot drift from the real types.
 */

export type { SuccessCriteria } from "@src/core/criteria";
export type { CriteriaVerdict as Verdict } from "@src/core/criteria";

export interface MiniEvaluator {
  uses: "command" | "experiment";
  as?: string;
  command?: string;
}

export interface MiniSpec {
  name: string;
  description?: string;
  requirements: string;
  language?: string;
  framework?: string;
  taskType: "function" | "api" | "webapp" | "experiment" | "generic";
  evaluators: MiniEvaluator[];
}

/** A demo evaluation result — the engine's EvaluationResult minus durationMs. */
export interface EvalResult {
  name: string;
  type: string;
  ok: boolean;
  passed: boolean;
  score?: number;
  feedback: string;
  error?: string;
}
