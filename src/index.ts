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
  BaselineReport,
  RunSnapshot,
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
export type { FeedbackDiff } from "./core/feedback";

// Plug-in contracts
export type {
  AgentDriver,
  AgentInvocation,
  AgentRunResult,
  AgentUsage,
  AgentStopReason,
  AgentEvent,
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
export { githubCopilotDriver } from "./drivers/github-copilot";
export { opencodeDriver } from "./drivers/opencode";
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
  createObserverRegistry,
} from "./registry";

// Infra
export { createLogger, silentLogger } from "./core/logger";
export type { Logger, LogLevel } from "./core/logger";
export { preflightOk, preflightFail, mergePreflight } from "./core/preflight";
export type { PreflightResult } from "./core/preflight";
export { runCommand } from "./core/exec";
export {
  isGitRepo,
  isIgnored,
  changeDetectionAvailable,
  snapshotTree,
  diffTrees,
  diffPatch,
  snapshotContent,
  diffContent,
  DEFAULT_MAX_PATCH_CHARS,
  CONTENT_SNAPSHOT_FILE_CAP,
} from "./core/workspace";
export type { TreeDiff, ContentSnapshot } from "./core/workspace";
export { resolveGuardedFiles, isTestLikePath } from "./core/evaluator-guard";
export { applyDriverOverride, validateDriverName } from "./core/driver-override";
export { unknownOptionKeys, unknownOptionWarnings } from "./drivers/options";
export {
  initTarget,
  listTargetTemplates,
  resolveTargetTemplate,
} from "./scaffold/init-target";
export type {
  InitTargetOptions,
  InitTargetResult,
  TargetTemplateMeta,
} from "./scaffold/init-target";

// Generation
export { generateSpec, specToYaml } from "./generate";
export type { GenerateInput } from "./generate";

// Batch
export {
  batchManifestSchema,
  batchItemSchema,
  parseBatchManifest,
  loadBatchFile,
  validateBatchManifest,
  BatchValidationError,
} from "./batch/manifest";
export type { BatchManifest, BatchItem, LoadedBatch } from "./batch/manifest";
export { runBatch } from "./batch/runner";
export type {
  RunBatchOptions,
  BatchReport,
  BatchItemResult,
  BatchItemStatus,
} from "./batch/runner";

// Observability (Stage-1 trace sink: loop + agent-event stream)
export { createTraceRecorder, runWithTrace, jsonlFileSink, arraySink } from "./observability/recorder";
export type {
  TraceRecord,
  TraceSink,
  TraceRecorder,
  TraceCommon,
  RecorderOptions,
  EvaluationTrace,
} from "./observability/types";

// Observers (the plug-in point: spec-referenceable telemetry consumers)
export type { Observer, ObserverSession, ObserverRunInfo } from "./observers/types";
export { jsonlObserver } from "./observers/jsonl";
export { otlpObserver, toOtlpTracePayload } from "./observers/otlp";
export type { OtlpTracePayload } from "./observers/otlp";

// Lint (Layer 0: static pre-execution checks)
export { lintSpec, lintBatch, lintPath, workspacePreflight, defaultKnownPlugins } from "./lint";
export type { LintResult } from "./lint";
export type { LintFinding, LintSeverity, SpecRule, KnownPlugins } from "./lint/types";
