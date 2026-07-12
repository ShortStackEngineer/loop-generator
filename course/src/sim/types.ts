/** Browser-side mirror of the spec/evaluator shapes the demos need. */

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

export interface EvalResult {
  name: string;
  type: string;
  ok: boolean;
  passed: boolean;
  score?: number;
  feedback: string;
  error?: string;
}

export type SuccessCriteria =
  | { type: "all-pass" }
  | { type: "pass"; evaluators: string[] }
  | { type: "score"; evaluator: string; gte?: number; lte?: number; eq?: number }
  | { type: "all"; of: SuccessCriteria[] }
  | { type: "any"; of: SuccessCriteria[] }
  | { type: "not"; of: SuccessCriteria };

export interface Verdict {
  satisfied: boolean;
  reason: string;
}
