import { Registry } from "./core/registry";
import type { EngineRegistries } from "./core/engine";
import type { AgentDriver } from "./drivers/types";
import type { Evaluator } from "./evaluators/types";
import type { TaskType } from "./tasks/types";
import { mockDriver } from "./drivers/mock";
import { claudeAgentSdkDriver } from "./drivers/claude-agent-sdk";
import { grokDriver } from "./drivers/grok";
import { commandEvaluator } from "./evaluators/command";
import { experimentEvaluator } from "./evaluators/experiment";
import { builtinTaskTypes } from "./tasks/builtin";

export function createDriverRegistry(): Registry<AgentDriver> {
  const r = new Registry<AgentDriver>("driver", (d) => d.name);
  r.register(mockDriver);
  r.register(claudeAgentSdkDriver);
  r.register(grokDriver);
  return r;
}

export function createEvaluatorRegistry(): Registry<Evaluator> {
  const r = new Registry<Evaluator>("evaluator", (e) => e.type);
  r.register(commandEvaluator);
  r.register(experimentEvaluator);
  return r;
}

export function createTaskRegistry(): Registry<TaskType> {
  const r = new Registry<TaskType>("task type", (t) => t.type);
  for (const t of builtinTaskTypes) r.register(t);
  return r;
}

/** All three registries pre-populated with the built-in plug-ins. */
export function createDefaultRegistries(): EngineRegistries {
  return {
    drivers: createDriverRegistry(),
    evaluators: createEvaluatorRegistry(),
    tasks: createTaskRegistry(),
  };
}
