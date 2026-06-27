import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Registry } from "./registry";
import type { AgentDriver, AgentRunResult, AgentUsage, FeedbackSummary } from "../drivers/types";
import type { Evaluator, EvaluationResult } from "../evaluators/types";
import type { TaskType } from "../tasks/types";
import { genericTask } from "../tasks/builtin";
import { evaluateCriteria } from "./criteria";
import { buildFeedback } from "./feedback";
import { mergePreflight } from "./preflight";
import type { PreflightResult } from "./preflight";
import { createLogger, type Logger } from "./logger";
import { resolveWorkspaceDir, type LoopSpec } from "./spec";

export interface EngineRegistries {
  drivers: Registry<AgentDriver>;
  evaluators: Registry<Evaluator>;
  tasks: Registry<TaskType>;
}

export interface IterationReport {
  iteration: number;
  agent: AgentRunResult;
  evaluations: EvaluationResult[];
  satisfied: boolean;
  reason: string;
  durationMs: number;
}

export type LoopOutcome = "success" | "max-iterations" | "preflight-failed" | "aborted" | "error";

export interface LoopReport {
  spec: string;
  outcome: LoopOutcome;
  success: boolean;
  reason: string;
  iterations: IterationReport[];
  totalUsage: AgentUsage;
  durationMs: number;
  preflight?: PreflightResult;
  error?: string;
}

export interface RunOptions {
  /** Directory the spec's relative paths resolve against (default: cwd). */
  baseDir?: string;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Called after every iteration (for live progress). */
  onIteration?: (report: IterationReport) => void;
  /** Skip preflight checks (not recommended). */
  skipPreflight?: boolean;
  log?: Logger;
}

function addUsage(a: AgentUsage, b?: AgentUsage): AgentUsage {
  if (!b) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** Combine the run signal with a per-iteration timeout, if configured. */
function iterationSignal(external: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (external) signals.push(external);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * The loop engine: resolve plug-ins, preflight, then iterate
 * (drive agent → evaluate → check criteria → feed back) until the success
 * criteria are met or the iteration budget is exhausted.
 */
export class LoopEngine {
  private readonly log: Logger;

  constructor(
    private readonly registries: EngineRegistries,
    log?: Logger,
  ) {
    this.log = log ?? createLogger("info", "engine");
  }

  async run(spec: LoopSpec, opts: RunOptions = {}): Promise<LoopReport> {
    const log = opts.log ?? this.log;
    const start = Date.now();
    const runId = randomUUID();
    const baseDir = opts.baseDir ?? process.cwd();
    const workdir = resolveWorkspaceDir(spec, baseDir);

    const base: LoopReport = {
      spec: spec.name,
      outcome: "error",
      success: false,
      reason: "",
      iterations: [],
      totalUsage: {},
      durationMs: 0,
    };

    // Resolve plug-ins up front so a typo fails fast with a helpful message.
    let driver: AgentDriver;
    let taskType: TaskType;
    let evaluators: { name: string; type: string; evaluator: Evaluator; options: Record<string, unknown> }[];
    try {
      driver = this.registries.drivers.get(spec.driver.uses);
      taskType = this.registries.tasks.tryGet(spec.task.type) ?? genericTask;
      evaluators = spec.evaluators.map((e) => ({
        name: e.as ?? e.uses,
        type: e.uses,
        evaluator: this.registries.evaluators.get(e.uses),
        options: e.options,
      }));
    } catch (err) {
      return { ...base, reason: (err as Error).message, error: (err as Error).message };
    }

    if (!existsSync(workdir)) {
      mkdirSync(workdir, { recursive: true });
      log.info(`created workspace ${workdir}`);
    }

    // Preflight: driver + every evaluator.
    if (!opts.skipPreflight) {
      const checks: PreflightResult[] = [];
      if (driver.preflight) checks.push(await driver.preflight({ workdir, options: spec.driver.options }));
      for (const e of evaluators) {
        if (e.evaluator.preflight) checks.push(await e.evaluator.preflight({ workdir, options: e.options }));
      }
      const merged = mergePreflight(checks);
      for (const w of merged.warnings ?? []) log.warn(w);
      if (!merged.ok) {
        return {
          ...base,
          outcome: "preflight-failed",
          reason: `preflight failed:\n${(merged.errors ?? []).map((e) => `  • ${e}`).join("\n")}`,
          preflight: merged,
          durationMs: Date.now() - start,
        };
      }
      base.preflight = merged;
    }

    const validationErrors = taskType.validate?.(spec) ?? [];
    if (validationErrors.length) {
      return {
        ...base,
        reason: `task validation failed: ${validationErrors.join("; ")}`,
        error: validationErrors.join("; "),
        durationMs: Date.now() - start,
      };
    }

    const systemPrompt = spec.prompts?.system ?? taskType.buildSystemPrompt(spec);
    const iterations: IterationReport[] = [];
    let totalUsage: AgentUsage = {};
    let feedback: FeedbackSummary | undefined;

    for (let i = 0; i < spec.limits.maxIterations; i++) {
      if (opts.signal?.aborted) {
        return { ...base, outcome: "aborted", reason: "run aborted", iterations, totalUsage, durationMs: Date.now() - start };
      }

      const iterStart = Date.now();
      const iterLog = log.child(`iter${i}`);
      iterLog.info(`starting iteration ${i + 1}/${spec.limits.maxIterations}`);

      const prompt =
        i === 0
          ? spec.prompts?.initial ?? taskType.buildInitialPrompt(spec)
          : taskType.buildIterationPrompt(spec, feedback!);

      const signal = iterationSignal(opts.signal, spec.limits.iterationTimeoutMs);

      // 1) Drive the agent.
      let agent: AgentRunResult;
      try {
        agent = await driver.run({
          runId,
          iteration: i,
          workdir,
          systemPrompt,
          prompt,
          feedback,
          options: spec.driver.options,
          signal,
          log: iterLog.child("driver"),
        });
      } catch (err) {
        agent = { ok: false, error: (err as Error).message };
      }
      totalUsage = addUsage(totalUsage, agent.usage);
      if (!agent.ok) {
        iterLog.warn(`driver error: ${agent.error}`);
      }

      // 2) Evaluate the workspace.
      const evaluations = await this.runEvaluators(evaluators, {
        runId,
        iteration: i,
        workdir,
        signal,
        log: iterLog.child("eval"),
      });

      // 3) Check criteria and build feedback for the next turn.
      const verdict = evaluateCriteria(spec.success, evaluations);
      feedback = buildFeedback(evaluations, verdict);

      const report: IterationReport = {
        iteration: i,
        agent,
        evaluations,
        satisfied: verdict.satisfied,
        reason: verdict.reason,
        durationMs: Date.now() - iterStart,
      };
      iterations.push(report);
      opts.onIteration?.(report);
      iterLog.info(`result: ${verdict.satisfied ? "PASS" : "not yet"} — ${verdict.reason}`);

      if (verdict.satisfied) {
        return {
          ...base,
          outcome: "success",
          success: true,
          reason: verdict.reason,
          iterations,
          totalUsage,
          durationMs: Date.now() - start,
        };
      }
    }

    return {
      ...base,
      outcome: "max-iterations",
      success: false,
      reason: `exhausted ${spec.limits.maxIterations} iteration(s) without satisfying: ${feedback?.reason ?? "criteria"}`,
      iterations,
      totalUsage,
      durationMs: Date.now() - start,
    };
  }

  private async runEvaluators(
    evaluators: { name: string; type: string; evaluator: Evaluator; options: Record<string, unknown> }[],
    ctx: { runId: string; iteration: number; workdir: string; signal?: AbortSignal; log: Logger },
  ): Promise<EvaluationResult[]> {
    return Promise.all(
      evaluators.map(async (e): Promise<EvaluationResult> => {
        const start = Date.now();
        try {
          const outcome = await e.evaluator.evaluate({
            runId: ctx.runId,
            iteration: ctx.iteration,
            workdir: ctx.workdir,
            options: e.options,
            signal: ctx.signal,
            log: ctx.log.child(e.name),
          });
          return {
            name: e.name,
            type: e.type,
            ok: outcome.ok ?? true,
            passed: outcome.passed,
            score: outcome.score,
            feedback: outcome.feedback,
            details: outcome.details,
            error: outcome.error,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          return {
            name: e.name,
            type: e.type,
            ok: false,
            passed: false,
            feedback: `Evaluator threw: ${(err as Error).message}`,
            error: (err as Error).message,
            durationMs: Date.now() - start,
          };
        }
      }),
    );
  }
}
