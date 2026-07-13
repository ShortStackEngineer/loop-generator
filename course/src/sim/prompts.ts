/**
 * Prompt assembly via the REAL task types (src/tasks/builtin.ts → base.ts),
 * imported through the @src alias. The course builds a full LoopSpec from the
 * demo's MiniSpec and calls the same buildSystemPrompt / buildInitialPrompt /
 * buildIterationPrompt the engine calls — character-for-character identical.
 */
import { builtinTaskTypes, genericTask } from "@src/tasks/builtin";
import type { TaskType } from "@src/tasks/types";
import type { LoopSpec } from "@src/core/spec";
import type { FeedbackSummary } from "@src/drivers/types";
import type { MiniSpec } from "./types";

function taskFor(spec: MiniSpec): TaskType {
  return builtinTaskTypes.find((t) => t.type === spec.taskType) ?? genericTask;
}

/** Expand a MiniSpec into a fully-defaulted LoopSpec (mirrors the zod defaults). */
export function toLoopSpec(mini: MiniSpec): LoopSpec {
  return {
    version: 1,
    name: mini.name,
    description: mini.description,
    task: { type: mini.taskType },
    stack: mini.language ? { language: mini.language, framework: mini.framework } : undefined,
    workspace: { dir: ".", snapshot: "none", ignore: [] },
    requirements: mini.requirements,
    driver: { uses: "mock", options: {} },
    evaluators: mini.evaluators.map((e) => ({
      uses: e.uses,
      as: e.as,
      options: e.command ? { command: e.command } : {},
    })),
    success: { type: "all-pass" },
    limits: { maxIterations: 5, baseline: false, specGuard: "warn", evaluatorGuard: "warn" },
    evaluation: { concurrency: 1 },
    observability: { observers: [] },
  };
}

export function buildSystemPrompt(spec: MiniSpec): string {
  return taskFor(spec).buildSystemPrompt(toLoopSpec(spec));
}

export function buildInitialPrompt(spec: MiniSpec): string {
  return taskFor(spec).buildInitialPrompt(toLoopSpec(spec));
}

export function buildIterationPrompt(spec: MiniSpec, feedback: FeedbackSummary): string {
  return taskFor(spec).buildIterationPrompt(toLoopSpec(spec), feedback);
}
