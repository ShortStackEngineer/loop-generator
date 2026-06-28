import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
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
import { isGitRepo, changeDetectionAvailable, snapshotTree, diffTrees, DEFAULT_IGNORE_GLOBS } from "./workspace";
import { addUsage } from "./usage";
import { workspacePreflight } from "../lint/spec-lint";

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
  /** Did the workspace actually change this iteration (git-detected)? */
  changed?: boolean;
  /** Files changed this iteration. */
  changedFiles?: string[];
  /** `git diff --stat` for this iteration. */
  diffStat?: string;
  /** Honest caveats about this iteration (incomplete agent, no-op success, …). */
  warnings: string[];
}

export interface BaselineReport {
  satisfied: boolean;
  reason: string;
  evaluations: EvaluationResult[];
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
  /** Result of the pre-run baseline evaluation, if it was run. */
  baseline?: BaselineReport;
  /** Files changed across the whole run (git-detected). */
  changedFiles?: string[];
  /** `git diff --stat` across the whole run. */
  diffStat?: string;
  /** Run-level caveats — surfaced even on success (false-positive guards). */
  warnings: string[];
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
  /** Force the pre-run baseline evaluation on/off, overriding the spec. */
  baseline?: boolean;
  /** Override the spec's iteration budget without mutating the spec object. */
  maxIterations?: number;
  /**
   * Absolute path to the loop spec file. When it lives inside the workspace, the
   * engine watches it for tampering (the agent editing its own success criteria)
   * and excludes it from the work diff.
   */
  specFile?: string;
  log?: Logger;
}

function hashFileSafe(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** First non-empty line of a (possibly multi-line) message, for terse logs. */
function firstLine(text: string | undefined): string {
  if (!text) return "(no detail)";
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no detail)";
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
    // Make the resolved workspace obvious up front — a wrong workdir (e.g. a
    // compounded relative path landing in $HOME) is otherwise silent.
    log.info(`workspace: ${workdir}`);

    const base: LoopReport = {
      spec: spec.name,
      outcome: "error",
      success: false,
      reason: "",
      iterations: [],
      totalUsage: {},
      durationMs: 0,
      warnings: [],
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
      // Workspace/exec sanity (resolved workdir is a real project, referenced
      // binaries/scripts exist) — catches misconfigured paths before any work.
      checks.push(workspacePreflight(spec, workdir));
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

    // Workspace change tracking: lets us detect "green but the agent changed
    // nothing", the signature of checks that don't exercise the requirement.
    const gitEnabled = changeDetectionAvailable(workdir);
    if (spec.workspace.snapshot === "git" && !isGitRepo(workdir)) {
      log.warn(`workspace.snapshot is "git" but ${workdir} is not a git repo; change detection disabled`);
    } else if (!gitEnabled) {
      log.debug(
        "git change detection unavailable (not a repo, or workspace is git-ignored); no-op detection falls back to driver-reported changes",
      );
    }
    const baselineTree = gitEnabled ? snapshotTree(workdir) : null;

    // Spec-integrity guard: if the loop spec lives inside the workspace, the
    // agent can edit its own success criteria. Watch it for changes and keep it
    // out of the work diff so a spec-only edit can't masquerade as real work.
    let specWatch: { rel: string; hash: string } | null = null;
    if (opts.specFile) {
      const rel = path.relative(workdir, opts.specFile);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const hash = hashFileSafe(opts.specFile);
        if (hash) specWatch = { rel, hash };
      }
    }

    const ignoreGlobs = [
      ...DEFAULT_IGNORE_GLOBS,
      ...spec.workspace.ignore,
      ...(specWatch ? [specWatch.rel] : []),
    ];

    const runWarnings: string[] = [];
    const checkSpecTamper = (): void => {
      if (!specWatch) return;
      const now = hashFileSafe(path.resolve(workdir, specWatch.rel));
      if (now && now !== specWatch.hash) {
        const msg = `the agent modified the loop spec file (${specWatch.rel}) during the run — success criteria may have been altered; this run evaluated the original in-memory spec, but re-verify the on-disk spec before re-running`;
        if (!runWarnings.includes(msg)) runWarnings.push(msg);
      }
    };
    const systemPrompt = spec.prompts?.system ?? taskType.buildSystemPrompt(spec);
    const iterations: IterationReport[] = [];
    let totalUsage: AgentUsage = {};
    let feedback: FeedbackSummary | undefined;
    let lastSessionId: string | undefined;
    let lastTree = baselineTree;

    // Baseline evaluation: run the checks once before any agent work. If they
    // already pass, the checks probably don't test the requirement.
    const wantBaseline = opts.baseline ?? spec.limits.baseline;
    let baseline: BaselineReport | undefined;
    if (wantBaseline && evaluators.length) {
      log.info("running baseline evaluation (no agent) — disable with limits.baseline: false");
      const baseEvals = await this.runEvaluators(evaluators, {
        runId,
        iteration: -1,
        workdir,
        signal: opts.signal,
        log: log.child("baseline"),
      });
      const baseVerdict = evaluateCriteria(spec.success, baseEvals);
      baseline = { satisfied: baseVerdict.satisfied, reason: baseVerdict.reason, evaluations: baseEvals };
      if (baseVerdict.satisfied) {
        const w = "success criteria already pass BEFORE any agent work — your checks likely do not verify the new requirement";
        runWarnings.push(w);
        log.warn(w);
      }
    }

    const maxIterations = opts.maxIterations ?? spec.limits.maxIterations;
    for (let i = 0; i < maxIterations; i++) {
      if (opts.signal?.aborted) {
        checkSpecTamper();
        return {
          ...base,
          outcome: "aborted",
          reason: "run aborted",
          iterations,
          totalUsage,
          warnings: runWarnings,
          baseline,
          durationMs: Date.now() - start,
        };
      }

      const iterStart = Date.now();
      const iterLog = log.child(`iter${i}`);
      iterLog.info(`starting iteration ${i + 1}/${maxIterations}`);

      const prompt =
        i === 0
          ? spec.prompts?.initial ?? taskType.buildInitialPrompt(spec)
          : taskType.buildIterationPrompt(spec, feedback!);

      const signal = iterationSignal(opts.signal, spec.limits.iterationTimeoutMs);
      const treeBefore = gitEnabled ? lastTree : null;

      // 1) Drive the agent. Offer the previous session for resume after an
      //    incomplete (max_turns) stop; drivers opt in to actually using it.
      let agent: AgentRunResult;
      try {
        agent = await driver.run({
          runId,
          iteration: i,
          workdir,
          systemPrompt,
          prompt,
          feedback,
          resumeSessionId: lastSessionId,
          options: spec.driver.options,
          signal,
          log: iterLog.child("driver"),
        });
      } catch (err) {
        agent = { ok: false, stopReason: "error", error: (err as Error).message };
      }
      totalUsage = addUsage(totalUsage, agent.usage);
      if (agent.sessionId) lastSessionId = agent.sessionId;
      if (!agent.ok) iterLog.warn(`driver error: ${firstLine(agent.error)}`);
      else if (agent.stopReason === "max_turns") iterLog.warn("agent stopped: max turns reached (incomplete)");

      // 2) Compute what actually changed, then evaluate the workspace.
      const treeAfter = gitEnabled ? snapshotTree(workdir) : null;
      lastTree = treeAfter ?? lastTree;
      const diff = diffTrees(workdir, treeBefore, treeAfter, ignoreGlobs);
      const changed = gitEnabled ? diff.changed : (agent.changedFiles?.length ?? 0) > 0;
      const changedFiles = gitEnabled ? diff.files : agent.changedFiles ?? [];

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

      // 4) Honest caveats about this iteration.
      const iterWarnings: string[] = [];
      if (verdict.satisfied && gitEnabled && !changed) {
        iterWarnings.push(
          "criteria satisfied but the agent changed no files — this run may not have done any work (checks may be vacuous)",
        );
      }
      if (verdict.satisfied && (agent.stopReason === "max_turns" || agent.stopReason === "error" || !agent.ok)) {
        iterWarnings.push(
          `criteria satisfied, but the agent did not complete (${agent.stopReason ?? "error"}); success rests on the checks alone`,
        );
      }
      for (const w of iterWarnings) iterLog.warn(w);

      const report: IterationReport = {
        iteration: i,
        agent,
        evaluations,
        satisfied: verdict.satisfied,
        reason: verdict.reason,
        durationMs: Date.now() - iterStart,
        changed,
        changedFiles,
        diffStat: diff.stat,
        warnings: iterWarnings,
      };
      iterations.push(report);
      opts.onIteration?.(report);
      iterLog.info(`result: ${verdict.satisfied ? "PASS" : "not yet"} — ${verdict.reason}`);

      if (verdict.satisfied) {
        checkSpecTamper();
        const overall = diffTrees(workdir, baselineTree, lastTree, ignoreGlobs);
        return {
          ...base,
          outcome: "success",
          success: true,
          reason: verdict.reason,
          iterations,
          totalUsage,
          baseline,
          changedFiles: gitEnabled ? overall.files : undefined,
          diffStat: gitEnabled ? overall.stat : undefined,
          warnings: [...runWarnings, ...iterWarnings],
          durationMs: Date.now() - start,
        };
      }
    }

    checkSpecTamper();
    const overall = diffTrees(workdir, baselineTree, lastTree, ignoreGlobs);
    return {
      ...base,
      outcome: "max-iterations",
      success: false,
      reason: `exhausted ${maxIterations} iteration(s) without satisfying: ${feedback?.reason ?? "criteria"}`,
      iterations,
      totalUsage,
      baseline,
      changedFiles: gitEnabled ? overall.files : undefined,
      diffStat: gitEnabled ? overall.stat : undefined,
      warnings: runWarnings,
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
