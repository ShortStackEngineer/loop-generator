/**
 * Faithful browser port of the prompt assembly in src/tasks/base.ts and the
 * task definitions in src/tasks/builtin.ts. What you see rendered in the
 * course is character-for-character what createTaskType would produce.
 */
import type { MiniSpec } from "./types";
import type { FeedbackSummary } from "./feedback";

interface TaskDef {
  role: string;
  guidance: string[];
}

export const TASK_DEFS: Record<MiniSpec["taskType"], TaskDef> = {
  function: {
    role: "You are an expert software engineer implementing a precise, well-tested function or module.",
    guidance: [
      "Cover edge cases and error handling, not just the happy path.",
      "Keep the public signature stable unless the requirements ask otherwise.",
      "Add or update tests so the behavior is pinned down.",
    ],
  },
  api: {
    role: "You are an expert backend engineer implementing an API feature.",
    guidance: [
      "Honor the endpoint contract: methods, paths, status codes, request/response shapes.",
      "Validate inputs and return meaningful errors.",
      "Cover the feature with integration tests that exercise the real handler.",
    ],
  },
  webapp: {
    role: "You are an expert full-stack/frontend engineer implementing a web application feature.",
    guidance: [
      "Ensure the project builds cleanly after your changes.",
      "Implement the user-facing behavior described, including loading/empty/error states where relevant.",
      "Add component or end-to-end tests for the new behavior.",
    ],
  },
  experiment: {
    role: "You are an expert engineer implementing a measurable experiment such as an A/B test or a performance optimization.",
    guidance: [
      "Implement the variants/changes described and the instrumentation needed to measure them.",
      "Emit metrics in a stable, machine-readable form (e.g. a JSON file or a command that prints JSON) so they can be scored.",
      "Optimize toward the target metric without breaking existing tests.",
    ],
  },
  generic: {
    role: "You are an expert software engineer completing a coding task.",
    guidance: [],
  },
};

function describeChecks(spec: MiniSpec): string {
  if (spec.evaluators.length === 0) {
    return "(no automated checks configured yet — satisfy the requirements directly)";
  }
  return spec.evaluators
    .map((e) => {
      const name = e.as ?? e.uses;
      const cmd = typeof e.command === "string" ? ` — runs \`${e.command}\`` : "";
      return `- **${name}** (${e.uses})${cmd}`;
    })
    .join("\n");
}

function stackLine(spec: MiniSpec): string {
  if (!spec.language) return "Unspecified stack.";
  const parts = [spec.language];
  if (spec.framework) parts.push(spec.framework);
  return parts.join(" / ");
}

export function buildSystemPrompt(spec: MiniSpec): string {
  const def = TASK_DEFS[spec.taskType];
  return [
    def.role,
    "",
    "You are operating inside an automated feedback loop. After each turn, the workspace is evaluated by automated checks and you are given the results. Your job is to satisfy the requirements and make all required checks pass.",
    "",
    "Operating rules:",
    "- Confine all edits to the workspace directory.",
    "- Make concrete edits and run commands yourself; do not ask the user questions.",
    "- Prefer minimal, correct changes. Do not weaken or delete checks to make them pass.",
    "- When you receive feedback, fix the failing checks without regressing the passing ones.",
    ...def.guidance.map((g) => `- ${g}`),
  ].join("\n");
}

export function buildInitialPrompt(spec: MiniSpec, criteriaDescription: string): string {
  return [
    `# Task: ${spec.name}`,
    spec.description ? `\n${spec.description}` : "",
    "",
    "## Requirements",
    spec.requirements.trim(),
    "",
    "## Stack",
    stackLine(spec),
    "",
    "## Success is measured by",
    `Goal: ${criteriaDescription}`,
    "",
    describeChecks(spec),
    "",
    "Implement the requirements now. The checks above will run automatically when you finish this turn.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildIterationPrompt(spec: MiniSpec, feedback: FeedbackSummary): string {
  return [
    `Iteration feedback for "${spec.name}":`,
    "",
    feedback.text,
    "",
    "Make the edits needed to satisfy the failing checks while keeping the passing ones green. Implement the fixes now.",
  ].join("\n");
}
