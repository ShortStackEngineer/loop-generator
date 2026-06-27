import { describeCriteria } from "../core/criteria";
import type { LoopSpec, SpecEvaluator } from "../core/spec";
import type { FeedbackSummary } from "../drivers/types";
import type { TaskType } from "./types";

/** Per-language defaults for "run the tests" and "type/static check" commands. */
interface LangCommands {
  test: string;
  check?: string;
}

const LANGUAGE_COMMANDS: Record<string, LangCommands> = {
  typescript: { test: "npm test", check: "npx tsc --noEmit" },
  javascript: { test: "npm test", check: "npx eslint ." },
  python: { test: "pytest -q", check: "ruff check ." },
  rust: { test: "cargo test", check: "cargo clippy -- -D warnings" },
  go: { test: "go test ./...", check: "go vet ./..." },
  java: { test: "mvn -q test" },
  ruby: { test: "bundle exec rspec" },
};

export function languageCommands(language?: string): LangCommands {
  const key = (language ?? "").toLowerCase();
  return LANGUAGE_COMMANDS[key] ?? { test: "echo 'configure your test command' && false" };
}

/** Standard test + static-check evaluator pair for a stack. */
export function standardEvaluators(spec: LoopSpec): SpecEvaluator[] {
  const cmds = languageCommands(spec.stack?.language);
  const evaluators: SpecEvaluator[] = [
    { uses: "command", as: "tests", options: { command: cmds.test } },
  ];
  if (cmds.check) {
    evaluators.push({ uses: "command", as: "static-check", options: { command: cmds.check } });
  }
  return evaluators;
}

// Stryker disable StringLiteral: the strings below are prompt/message prose
// (LLM instructions and human-facing formatting), not logic. Mutating wording
// is not a real defect, so exact-text assertions would be brittle and low-value.
function describeChecks(spec: LoopSpec): string {
  if (spec.evaluators.length === 0) {
    return "(no automated checks configured yet — satisfy the requirements directly)";
  }
  return spec.evaluators
    .map((e) => {
      const name = e.as ?? e.uses;
      const cmd = typeof e.options?.command === "string" ? ` — runs \`${e.options.command}\`` : "";
      return `- **${name}** (${e.uses})${cmd}`;
    })
    .join("\n");
}

function stackLine(spec: LoopSpec): string {
  if (!spec.stack) return "Unspecified stack.";
  const parts = [spec.stack.language];
  if (spec.stack.framework) parts.push(spec.stack.framework);
  if (spec.stack.packageManager) parts.push(`(${spec.stack.packageManager})`);
  return parts.join(" / ");
}

/**
 * A configurable base TaskType. Specializations supply a `role` (how to frame
 * the agent), `guidance` (category-specific dos/don'ts), and recommended
 * evaluators; the prompt assembly is shared so every category behaves
 * consistently inside the loop.
 */
export function createTaskType(config: {
  type: string;
  description: string;
  role: string;
  guidance: string[];
  recommendedEvaluators: (spec: LoopSpec) => SpecEvaluator[];
  validate?: (spec: LoopSpec) => string[];
}): TaskType {
  return {
    type: config.type,
    description: config.description,
    recommendedEvaluators: config.recommendedEvaluators,
    validate: config.validate,

    buildSystemPrompt(spec) {
      return [
        config.role,
        "",
        "You are operating inside an automated feedback loop. After each turn, the workspace is evaluated by automated checks and you are given the results. Your job is to satisfy the requirements and make all required checks pass.",
        "",
        "Operating rules:",
        "- Confine all edits to the workspace directory.",
        "- Make concrete edits and run commands yourself; do not ask the user questions.",
        "- Prefer minimal, correct changes. Do not weaken or delete checks to make them pass.",
        "- When you receive feedback, fix the failing checks without regressing the passing ones.",
        ...config.guidance.map((g) => `- ${g}`),
      ].join("\n");
    },

    buildInitialPrompt(spec) {
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
        `Goal: ${describeCriteria(spec.success)}`,
        "",
        describeChecks(spec),
        "",
        "Implement the requirements now. The checks above will run automatically when you finish this turn.",
      ]
        .filter((l) => l !== "")
        .join("\n");
    },

    buildIterationPrompt(spec, feedback: FeedbackSummary) {
      if (spec.prompts?.iteration) {
        return `${spec.prompts.iteration}\n\n${feedback.text}`;
      }
      return [
        `Iteration feedback for "${spec.name}":`,
        "",
        feedback.text,
        "",
        "Make the edits needed to satisfy the failing checks while keeping the passing ones green. Implement the fixes now.",
      ].join("\n");
    },
  };
}
