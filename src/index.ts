/**
 * loop-generator — generate and run agent coding feedback loops.
 *
 * Public API. The three extension points are drivers (agents), evaluators
 * (feedback tools), and task types (prompt scaffolding). Register your own on
 * the registries and pass them to `LoopEngine`.
 */

// Engine + reports
export { LoopEngine } from "./core/engine";
export type {
  EngineRegistries,
  RunOptions,
  LoopReport,
  LoopOutcome,
  IterationReport,
} from "./core/engine";

// Spec
export {
  loopSpecSchema,
  specEvaluatorSchema,
  parseSpec,
  loadSpecFile,
  resolveWorkspaceDir,
  SpecValidationError,
} from "./core/spec";
export type { LoopSpec, SpecEvaluator, LoadedSpec } from "./core/spec";

// Success criteria
export { evaluateCriteria, describeCriteria, successCriteriaSchema } from "./core/criteria";
export type { SuccessCriteria, CriteriaVerdict } from "./core/criteria";

// Feedback
export { buildFeedback } from "./core/feedback";

// Plug-in contracts
export type {
  AgentDriver,
  AgentInvocation,
  AgentRunResult,
  AgentUsage,
  FeedbackSummary,
} from "./drivers/types";
export type {
  Evaluator,
  EvaluationContext,
  EvaluationOutcome,
  EvaluationResult,
} from "./evaluators/types";
export type { TaskType } from "./tasks/types";

// Built-in plug-ins
export { mockDriver } from "./drivers/mock";
export { claudeAgentSdkDriver } from "./drivers/claude-agent-sdk";
export { grokDriver } from "./drivers/grok";
export { commandEvaluator } from "./evaluators/command";
export { experimentEvaluator } from "./evaluators/experiment";
export {
  functionTask,
  apiTask,
  webappTask,
  experimentTask,
  genericTask,
  builtinTaskTypes,
} from "./tasks/builtin";
export { createTaskType, standardEvaluators, languageCommands } from "./tasks/base";

// Registries
export { Registry } from "./core/registry";
export {
  createDefaultRegistries,
  createDriverRegistry,
  createEvaluatorRegistry,
  createTaskRegistry,
} from "./registry";

// Infra
export { createLogger, silentLogger } from "./core/logger";
export type { Logger, LogLevel } from "./core/logger";
export { preflightOk, preflightFail, mergePreflight } from "./core/preflight";
export type { PreflightResult } from "./core/preflight";
export { runCommand } from "./core/exec";

// Generation
export { generateSpec, specToYaml } from "./generate";
export type { GenerateInput } from "./generate";
