import { createTaskType, standardEvaluators } from "./base";
import type { TaskType } from "./types";

// Stryker disable StringLiteral: task definitions are declarative prose (role,
// guidance, descriptions) and config defaults — not logic. The structural logic
// (which evaluators each type recommends) is still mutated and asserted.

export const functionTask: TaskType = createTaskType({
  type: "function",
  description: "Implement or modify a self-contained function/module with test coverage.",
  role: "You are an expert software engineer implementing a precise, well-tested function or module.",
  guidance: [
    "Cover edge cases and error handling, not just the happy path.",
    "Keep the public signature stable unless the requirements ask otherwise.",
    "Add or update tests so the behavior is pinned down.",
  ],
  recommendedEvaluators: standardEvaluators,
});

export const apiTask: TaskType = createTaskType({
  type: "api",
  description: "Implement an API/endpoint feature with contract and integration coverage.",
  role: "You are an expert backend engineer implementing an API feature.",
  guidance: [
    "Honor the endpoint contract: methods, paths, status codes, request/response shapes.",
    "Validate inputs and return meaningful errors.",
    "Cover the feature with integration tests that exercise the real handler.",
  ],
  recommendedEvaluators: standardEvaluators,
});

export const webappTask: TaskType = createTaskType({
  type: "webapp",
  description: "Implement a web app/UI feature with build + behavior verification.",
  role: "You are an expert full-stack/frontend engineer implementing a web application feature.",
  guidance: [
    "Ensure the project builds cleanly after your changes.",
    "Implement the user-facing behavior described, including loading/empty/error states where relevant.",
    "Add component or end-to-end tests for the new behavior.",
  ],
  recommendedEvaluators: (spec) => {
    const evals = standardEvaluators(spec);
    // Web apps almost always need a build gate in addition to tests.
    evals.push({ uses: "command", as: "build", options: { command: "npm run build" } });
    return evals;
  },
});

export const experimentTask: TaskType = createTaskType({
  type: "experiment",
  description: "Implement an experiment (e.g. A/B test) and converge on a target metric.",
  role: "You are an expert engineer implementing a measurable experiment such as an A/B test or a performance optimization.",
  guidance: [
    "Implement the variants/changes described and the instrumentation needed to measure them.",
    "Emit metrics in a stable, machine-readable form (e.g. a JSON file or a command that prints JSON) so they can be scored.",
    "Optimize toward the target metric without breaking existing tests.",
  ],
  recommendedEvaluators: (spec) => {
    const evals = standardEvaluators(spec);
    evals.push({
      uses: "experiment",
      as: "metric",
      options: {
        metricsFile: "metrics.json",
        metric: "value",
        direction: "increase",
      },
    });
    return evals;
  },
});

/**
 * Fallback used when a spec references an unregistered `task.type`. Keeps the
 * loop runnable for custom categories with no bespoke prompt scaffolding.
 */
export const genericTask: TaskType = createTaskType({
  type: "generic",
  description: "Generic coding task with no category-specific guidance.",
  role: "You are an expert software engineer completing a coding task.",
  guidance: [],
  recommendedEvaluators: standardEvaluators,
});

export const builtinTaskTypes: TaskType[] = [
  functionTask,
  apiTask,
  webappTask,
  experimentTask,
  genericTask,
];
