import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { Registry } from "./registry";
import type { AgentDriver, AgentEvent, AgentRunResult, AgentUsage, FeedbackSummary } from "../drivers/types";
import type { Evaluator, EvaluationResult } from "../evaluators/types";
import type { TaskType } from "../tasks/types";
import type { Observer, ObserverSession } from "../observers/types";
import { genericTask } from "../tasks/builtin";
import { evaluateCriteria } from "./criteria";
import { buildFeedback } from "./feedback";
import { mergePreflight } from "./preflight";
import type { PreflightResult } from "./preflight";
import { createLogger, type Logger } from "./logger";
import { resolveWorkspaceDir, type LoopSpec } from "./spec";
import {
  isGitRepo,
  changeDetectionAvailable,
  snapshotTree,
  commitTreeToRef,
  diffTrees,
  diffPatch,
  snapshotContent,
  diffContent,
  DEFAULT_IGNORE_GLOBS,
  CONTENT_SNAPSHOT_FILE_CAP,
  type ContentSnapshot,
  type TreeDiff,
} from "./workspace";
import { resolveGuardedFiles } from "./evaluator-guard";
import { resolveHoldouts, materializeHoldouts, type HoldoutMapping } from "./holdout";
import { addUsage } from "./usage";
import { workspacePreflight } from "../lint/spec-lint";

export interface EngineRegistries {
  drivers: Registry<AgentDriver>;
  evaluators: Registry<Evaluator>;
  tasks: Registry<TaskType>;
  /** Telemetry consumers referenced by `observability.observers[].uses`. Optional
   * so existing hand-built registries keep working; absent means "no observers". */
  observers?: Registry<Observer>;
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
  /**
   * How many times the agent ran each evaluator's command itself during this
   * iteration (evaluator name → count), detected from `tool-call` trajectory
   * events whose command matches. A capable agentic driver typically self-runs
   * the graders and converges in one engine iteration — this field makes that
   * inner loop visible. Best-effort: only drivers that emit tool-call events
   * with a command-like input are counted; absent when nothing matched.
   */
  selfEvalRuns?: Record<string, number>;
  /** Honest caveats about this iteration (incomplete agent, no-op success, …). */
  warnings: string[];
}

export interface BaselineReport {
  satisfied: boolean;
  reason: string;
  evaluations: EvaluationResult[];
}

export type LoopOutcome =
  | "success"
  | "max-iterations"
  | "preflight-failed"
  | "aborted"
  | "error"
  | "baseline-vacuous"
  | "spec-tampered"
  | "evaluator-tampered"
  | "budget-exceeded";

/**
 * Git checkpoints written when `workspace.snapshot: "git"` is set on a git
 * workspace. Non-destructive refs under `refs/loopgen/<run>/*` that let a
 * failed run be inspected and reset. Absent when snapshotting is off, the
 * workspace isn't a git repo, or the pre-run snapshot couldn't be written.
 */
export interface RunSnapshot {
  /** Ref at the pre-run workspace state — the restore target. */
  preRunRef: string;
  /** Ref at the latest per-iteration checkpoint (the agent's cumulative work). */
  latestRef?: string;
  /** Iteration checkpoints written (one per iteration that changed files). */
  checkpoints: number;
  /** Copy-pasteable command to restore the workspace to its pre-run state. */
  resetCommand: string;
  /** Copy-pasteable command to inspect what changed across the run. */
  inspectCommand?: string;
}

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
  /** Git checkpoints for inspect/reset, when `workspace.snapshot: "git"`. */
  snapshot?: RunSnapshot;
  error?: string;
}

export interface RunOptions {
  /** Directory the spec's relative paths resolve against (default: cwd). */
  baseDir?: string;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Called after every iteration (for live progress). */
  onIteration?: (report: IterationReport) => void;
  /**
   * Called for each inner-trajectory event a driver emits during an iteration
   * (model output, tool calls, results). Live; tagged with the run id and the
   * 0-based iteration. A throwing handler can never break the run. This is the
   * minimal seam an observability sink (OTLP, a JSONL trace, Raindrop) hooks.
   */
  onAgentEvent?: (event: AgentEvent, ctx: { runId: string; iteration: number }) => void;
  /** Skip preflight checks (not recommended). */
  skipPreflight?: boolean;
  /**
   * Force the pre-run baseline evaluation, overriding the spec. `true`/`false`
   * turn it on/off; `"strict"` also fails the run if the baseline already passes.
   */
  baseline?: boolean | "strict";
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

/**
 * POSIX single-quote a string so an interpolated path stays paste-safe in a
 * shell — a workspace like `/Users/Kyle Smith/proj` must survive copy-paste
 * (spaces, `$`, `;`, quotes). Wrap in single quotes; a literal `'` becomes
 * `'\''` (close-quote, escaped quote, reopen-quote).
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Pull a command string out of a `tool-call` event's input, if it has one.
 * Recognizes the common shapes drivers emit (`command`, `cmd`, `script`, or a
 * string-array `args`). Deliberately conservative: a file-write input carrying
 * a command inside file *content* has none of these keys, so it never counts.
 */
export function extractCommandText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "commandLine"]) {
    if (typeof o[key] === "string") return o[key] as string;
  }
  const args = o["args"];
  if (Array.isArray(args) && args.length > 0 && args.every((a) => typeof a === "string")) {
    return (args as string[]).join(" ");
  }
  return null;
}

/**
 * If cumulative usage has exceeded a configured budget, return a human-readable
 * reason; otherwise null. Cost is checked first, then combined input+output
 * tokens. A missing usage field counts as 0, so an un-instrumented driver
 * (mock, tests) simply never trips a budget.
 */
function budgetExceeded(usage: AgentUsage, limits: LoopSpec["limits"]): string | null {
  const cost = usage.costUsd ?? 0;
  if (typeof limits.maxCostUsd === "number" && cost > limits.maxCostUsd) {
    return `cost budget exceeded: $${cost.toFixed(4)} spent > $${limits.maxCostUsd.toFixed(4)} limit (limits.maxCostUsd)`;
  }
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (typeof limits.maxTokens === "number" && tokens > limits.maxTokens) {
    return `token budget exceeded: ${tokens} tokens used (input + output) > ${limits.maxTokens} limit (limits.maxTokens)`;
  }
  return null;
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving the input order in the returned results. A `limit` at or above
 * `items.length` behaves like `Promise.all`; a `limit` of `1` runs fully
 * sequentially. Used to keep evaluators that share external state (one DB, say)
 * from racing, while still allowing opt-in parallelism for independent checks.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
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
    let observers: { observer: Observer; options: Record<string, unknown> }[];
    try {
      driver = this.registries.drivers.get(spec.driver.uses);
      taskType = this.registries.tasks.tryGet(spec.task.type) ?? genericTask;
      evaluators = spec.evaluators.map((e) => ({
        name: e.as ?? e.uses,
        type: e.uses,
        evaluator: this.registries.evaluators.get(e.uses),
        options: e.options,
      }));
      const observerRegistry = this.registries.observers;
      observers = (spec.observability?.observers ?? []).map((o) => {
        if (!observerRegistry) {
          throw new Error(`No observer registry is configured, but the spec declares observer "${o.uses}".`);
        }
        return { observer: observerRegistry.get(o.uses), options: o.options };
      });
    } catch (err) {
      return { ...base, reason: (err as Error).message, error: (err as Error).message };
    }

    // Holdout graders: validate every `evaluators[].holdout` mapping before any
    // agent spend — an evaluator whose grader can't be materialized measures
    // nothing, so a bad mapping is a hard config error, not a mid-run surprise.
    const holdouts = resolveHoldouts(spec, baseDir, workdir);
    if (holdouts.errors.length) {
      const reason = `holdout configuration invalid:\n${holdouts.errors.map((e) => `  • ${e}`).join("\n")}`;
      return { ...base, reason, error: reason, durationMs: Date.now() - start };
    }
    for (const w of holdouts.warnings) log.warn(w);

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
      for (const o of observers) {
        if (o.observer.preflight) checks.push(await o.observer.preflight({ workdir, options: o.options }));
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
    // Prefer git; when unavailable, fall back to a content-hash walk so a
    // driver that omits `changedFiles` can't produce a false vacuous warning.
    const gitEnabled = changeDetectionAvailable(workdir);
    const contentFallback = !gitEnabled;
    if (spec.workspace.snapshot === "git" && !isGitRepo(workdir)) {
      log.warn(
        `workspace.snapshot is "git" but ${workdir} is not a git repo; using content-hash change detection`,
      );
    } else if (!gitEnabled) {
      log.debug(
        "git change detection unavailable (not a repo, or workspace is git-ignored); using content-hash change detection (driver-reported files as secondary)",
      );
    }
    const baselineTree = gitEnabled ? snapshotTree(workdir) : null;
    let baselineContent: ContentSnapshot | null = null;

    // Honor `workspace.snapshot: "git"` (opt-in): checkpoint the workspace into
    // dedicated refs so a failed run can be inspected and reset — the behavior
    // the flag has always promised. Non-destructive: commits are written under
    // refs/loopgen/<runId>/* via commit-tree, never touching HEAD, the index,
    // or the working tree. Best-effort — a snapshot failure never fails the run.
    const preRunRef = `refs/loopgen/${runId}/pre-run`;
    const latestRef = `refs/loopgen/${runId}/latest`;
    const wantSnapshot = spec.workspace.snapshot === "git" && gitEnabled && baselineTree !== null;
    let lastCheckpoint: string | null = null;
    let checkpoints = 0;
    if (wantSnapshot) {
      lastCheckpoint = commitTreeToRef(workdir, preRunRef, baselineTree!, "loopgen: pre-run snapshot", null);
      if (lastCheckpoint) {
        base.snapshot = {
          preRunRef,
          checkpoints: 0,
          // `checkout … -- .` restores snapshot paths into the worktree (works
          // even with no HEAD/initial commit, where `restore --source` doesn't);
          // `clean -fd` drops files the agent added. Both are non-destructive to
          // the run refs.
          resetCommand: `git -C ${shQuote(workdir)} checkout ${preRunRef} -- . && git -C ${shQuote(workdir)} clean -fd`,
        };
        log.info(`pre-run snapshot saved at ${preRunRef} (reset with: ${base.snapshot.resetCommand})`);
      } else {
        log.warn(`workspace.snapshot: "git" requested but the pre-run snapshot could not be written; this run won't be resettable`);
      }
    }

    // Spec-integrity guard: if the loop spec lives inside the workspace, the
    // agent can edit its own success criteria. Two independent concerns:
    //   1. Always keep the spec out of the work diff so a spec-only edit can't
    //      masquerade as real work — independent of the guard policy.
    //   2. Hash-watch it for tampering, unless `specGuard: "off"`.
    // (`"warn"` surfaces a caveat; `"error"` fails the run on tamper.)
    const specGuard = spec.limits.specGuard;
    let specRel: string | undefined;
    if (opts.specFile) {
      const rel = path.relative(workdir, opts.specFile);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) specRel = rel;
    }
    let specWatch: { rel: string; hash: string } | null = null;
    if (specGuard !== "off" && specRel) {
      const hash = hashFileSafe(path.resolve(workdir, specRel));
      if (hash) specWatch = { rel: specRel, hash };
    }

    // Evaluator-integrity guard: the real success criteria for a `command` check
    // are the test files it runs. Watch those (auto-detected from commands plus
    // explicit `evaluators[].guard`) so the agent can't fake a green by editing
    // them, and keep them out of the work diff so such edits don't count as work.
    const evaluatorGuard = spec.limits.evaluatorGuard;
    const guardedRels = evaluatorGuard === "off" ? [] : resolveGuardedFiles(spec, workdir);
    const evaluatorWatch: { rel: string; hash: string }[] = [];
    for (const rel of guardedRels) {
      const hash = hashFileSafe(path.resolve(workdir, rel));
      if (hash) evaluatorWatch.push({ rel, hash });
    }
    // Holdout sources are evaluator dependencies too: they live outside the
    // workspace, but an agent with shell access can still reach them, so they
    // are hash-watched under the same policy (label keeps messages readable).
    const holdoutWatch: { label: string; abs: string; hash: string }[] = [];
    if (evaluatorGuard !== "off") {
      for (const m of holdouts.mappings) {
        const hash = hashFileSafe(m.from);
        if (hash) holdoutWatch.push({ label: `${m.to} (holdout source)`, abs: m.from, hash });
      }
    }

    const ignoreGlobs = [
      ...DEFAULT_IGNORE_GLOBS,
      ...spec.workspace.ignore,
      // Exclude the spec from the work diff whenever it's a valid in-workspace
      // path — even with the watch off — so editing it never counts as "work".
      ...(specRel ? [specRel] : []),
      // Likewise, guarded evaluator files: editing the checks isn't "work".
      ...guardedRels,
      // Holdout destinations are only present while evaluators run, but exclude
      // them anyway so a stray leftover can never count as agent work.
      ...holdouts.mappings.map((m) => m.to),
    ];

    const runWarnings: string[] = [...holdouts.warnings];
    // Off-git: content-hash detection is independent of the driver, but lacks
    // unified diffs and respects a file-count cap — still flag it so a green
    // run never *looks* identical to a git-backed one.
    if (contentFallback) {
      baselineContent = snapshotContent(workdir, ignoreGlobs);
      runWarnings.push(
        "git change detection is unavailable (workspace is not a git repo, or is git-ignored); file changes are detected via content hashes (no unified diff; large trees are capped)",
      );
    }

    /** Union of files changed across iterations (used for the overall report off-git). */
    const overallChangedFiles = new Set<string>();
    /** Carry the last content snapshot so each iteration walks the tree once (after), not twice. */
    let lastContent: ContentSnapshot | null = baselineContent;
    let specTampered = false;
    // Re-hash the watched spec and flag tampering. Called on every terminal path
    // that could have seen agent activity (per-iteration success, max-iterations,
    // abort); pre-loop returns (preflight/validation/baseline-vacuous) can't have
    // tampering. A no-op when the watch is inactive (specGuard "off" or no specFile).
    const checkSpecTamper = (): void => {
      if (!specWatch) return;
      const now = hashFileSafe(path.resolve(workdir, specWatch.rel));
      if (now && now !== specWatch.hash) {
        specTampered = true;
        const msg = `the agent modified the loop spec file (${specWatch.rel}) during the run — success criteria may have been altered; this run evaluated the original in-memory spec, but re-verify the on-disk spec before re-running`;
        if (!runWarnings.includes(msg)) runWarnings.push(msg);
      }
    };
    let evaluatorTampered = false;
    let tamperedEvalFiles: string[] = [];
    // Re-hash guarded evaluator files and flag tampering — same lifecycle as
    // checkSpecTamper. A watched file that changed (or went missing) is tampering.
    const checkEvaluatorTamper = (): void => {
      if (!evaluatorWatch.length && !holdoutWatch.length) return;
      const changed: string[] = [];
      for (const w of evaluatorWatch) {
        const now = hashFileSafe(path.resolve(workdir, w.rel));
        if (now !== w.hash) changed.push(w.rel);
      }
      for (const w of holdoutWatch) {
        // A source that changed or went missing mid-run is tampering either way.
        const now = hashFileSafe(w.abs);
        if (now !== w.hash) changed.push(w.label);
      }
      if (changed.length) {
        evaluatorTampered = true;
        tamperedEvalFiles = changed;
        const msg = `the agent modified file(s) an evaluator depends on (${changed.join(", ")}) — the success checks themselves may have been altered; re-verify before trusting this result`;
        if (!runWarnings.includes(msg)) runWarnings.push(msg);
      }
    };
    // Self-verification telemetry: evaluator commands to look for inside the
    // agent's own trajectory. A tool-call whose command contains one of these
    // means the agent ran the grader itself — the inner loop the engine's
    // 1-iteration convergence otherwise hides.
    const evalCommands = evaluators.flatMap((e) => {
      const command = e.options?.command;
      return typeof command === "string" && command.trim() ? [{ name: e.name, command: command.trim() }] : [];
    });
    const systemPrompt = spec.prompts?.system ?? taskType.buildSystemPrompt(spec);
    const iterations: IterationReport[] = [];
    let totalUsage: AgentUsage = {};
    let feedback: FeedbackSummary | undefined;
    let lastSessionId: string | undefined;
    let lastTree = baselineTree;

    // Observers: begin one session per resolved observer now that the run is
    // committed (past preflight). They see iteration + agent events live and the
    // terminal report; a failing observer is isolated, never breaking the run.
    const observerSessions = this.beginObservers(observers, { runId, workdir, baseDir, spec }, log);

    // Baseline evaluation: run the checks once before any agent work. If they
    // already pass, the checks probably don't test the requirement.
    const baselineSetting = opts.baseline ?? spec.limits.baseline;
    const wantBaseline = baselineSetting !== false;
    const strictBaseline = baselineSetting === "strict";
    let baseline: BaselineReport | undefined;
    if (wantBaseline && evaluators.length) {
      log.info("running baseline evaluation (no agent) — disable with limits.baseline: false");
      const baseEvals = await this.runEvaluators(evaluators, {
        runId,
        iteration: -1,
        workdir,
        concurrency: spec.evaluation.concurrency,
        signal: opts.signal,
        log: log.child("baseline"),
        holdouts: holdouts.mappings,
        onHoldoutNotes: (notes) => runWarnings.push(...notes.filter((n) => !runWarnings.includes(n))),
      });
      const baseVerdict = evaluateCriteria(spec.success, baseEvals);
      baseline = { satisfied: baseVerdict.satisfied, reason: baseVerdict.reason, evaluations: baseEvals };
      if (baseVerdict.satisfied) {
        const w = "success criteria already pass BEFORE any agent work — your checks likely do not verify the new requirement";
        runWarnings.push(w);
        log.warn(w);
        // Strict baseline: a vacuous check set is a hard failure, not a caveat.
        if (strictBaseline) {
          return this.finishObservers(observerSessions, {
            ...base,
            outcome: "baseline-vacuous",
            reason: `strict baseline: ${w}`,
            baseline,
            warnings: runWarnings,
            durationMs: Date.now() - start,
          });
        }
      }
    }

    const maxIterations = opts.maxIterations ?? spec.limits.maxIterations;
    for (let i = 0; i < maxIterations; i++) {
      if (opts.signal?.aborted) {
        checkSpecTamper();
        checkEvaluatorTamper();
        return this.finishObservers(observerSessions, {
          ...base,
          outcome: "aborted",
          reason: "run aborted",
          iterations,
          totalUsage,
          warnings: runWarnings,
          baseline,
          durationMs: Date.now() - start,
        });
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
      // Reuse the previous iteration's post-snapshot (or baseline) so we don't
      // re-hash the whole tree before every agent turn. Evaluators run after the
      // after-snapshot, so their artifacts never count as agent work.
      const contentBefore = contentFallback ? lastContent : null;

      // 1) Drive the agent. Offer the previous session for resume after an
      //    incomplete (max_turns) stop; drivers opt in to actually using it.
      const selfEvalCounts = new Map<string, number>();
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
          emit:
            opts.onAgentEvent || observerSessions.length || evalCommands.length
              ? (event) => {
                  // Count the agent running a grader command itself (inner-loop
                  // self-verification) before forwarding to sinks.
                  if (event.kind === "tool-call" && evalCommands.length) {
                    const text = extractCommandText(event.input);
                    if (text) {
                      for (const ec of evalCommands) {
                        if (text.includes(ec.command)) {
                          selfEvalCounts.set(ec.name, (selfEvalCounts.get(ec.name) ?? 0) + 1);
                        }
                      }
                    }
                  }
                  // An observability sink must never break a run; each consumer
                  // is isolated so a throw can't fail the iteration.
                  if (opts.onAgentEvent) {
                    try {
                      opts.onAgentEvent(event, { runId, iteration: i });
                    } catch {
                      /* ignore */
                    }
                  }
                  for (const s of observerSessions) {
                    try {
                      s.onAgentEvent?.(event, { iteration: i });
                    } catch {
                      /* ignore */
                    }
                  }
                }
              : undefined,
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

      // Checkpoint this iteration's result (only when it actually changed the
      // tree) so `latest` chains readable per-turn history back to `pre-run`.
      if (wantSnapshot && lastCheckpoint && treeAfter && treeAfter !== treeBefore) {
        const oid = commitTreeToRef(workdir, latestRef, treeAfter, `loopgen: iteration ${i + 1}`, lastCheckpoint);
        if (oid) {
          lastCheckpoint = oid;
          checkpoints += 1;
          base.snapshot = {
            ...base.snapshot!,
            latestRef,
            checkpoints,
            inspectCommand: `git -C ${shQuote(workdir)} diff ${preRunRef} ${latestRef}`,
          };
        }
      }
      const gitDiff = diffTrees(workdir, treeBefore, treeAfter, ignoreGlobs);
      const contentAfter = contentFallback ? snapshotContent(workdir, ignoreGlobs) : null;
      if (contentAfter) lastContent = contentAfter;
      const contentDiff: TreeDiff | null =
        contentFallback && contentBefore && contentAfter ? diffContent(contentBefore, contentAfter) : null;

      // Resolution order: git → content-hash → driver self-report.
      let changed: boolean;
      let changedFiles: string[];
      let iterDiffStat = "";
      /** Driver claimed files when content-hash saw none — only trusted if the walk hit the cap. */
      let driverClaimUnverified = false;
      if (gitEnabled) {
        changed = gitDiff.changed;
        changedFiles = gitDiff.files;
        iterDiffStat = gitDiff.stat;
      } else if (contentDiff) {
        changed = contentDiff.changed;
        changedFiles = contentDiff.files;
        // Content-hash is authoritative under the file cap. Only defer to the
        // driver's self-report when the walk may have missed files (cap hit).
        const hitCap =
          (contentBefore?.size ?? 0) >= CONTENT_SNAPSHOT_FILE_CAP ||
          (contentAfter?.size ?? 0) >= CONTENT_SNAPSHOT_FILE_CAP;
        if (!contentDiff.changed && (agent.changedFiles?.length ?? 0) > 0) {
          if (hitCap) {
            changed = true;
            changedFiles = agent.changedFiles!;
            driverClaimUnverified = true;
            iterDiffStat = `${agent.changedFiles!.length} file(s) driver-reported (content-hash walk hit cap)`;
          }
          // else: ignore the claim — a fabricating driver must not silence the vacuous guard
        }
        if (!iterDiffStat) iterDiffStat = contentDiff.stat;
      } else {
        changed = (agent.changedFiles?.length ?? 0) > 0;
        changedFiles = agent.changedFiles ?? [];
      }
      for (const f of changedFiles) overallChangedFiles.add(f);

      const evaluations = await this.runEvaluators(evaluators, {
        runId,
        iteration: i,
        workdir,
        concurrency: spec.evaluation.concurrency,
        signal,
        log: iterLog.child("eval"),
        holdouts: holdouts.mappings,
        onHoldoutNotes: (notes) => runWarnings.push(...notes.filter((n) => !runWarnings.includes(n))),
      });

      // 3) Check criteria and build feedback for the next turn. When git change
      //    detection is on and this iteration actually changed something, hand
      //    the agent a bounded diff of what it just did — this feedback becomes
      //    the next iteration's prompt, so it stops re-deriving known state.
      const verdict = evaluateCriteria(spec.success, evaluations);
      feedback = buildFeedback(evaluations, verdict, {
        diff:
          gitEnabled && gitDiff.changed
            ? { files: gitDiff.files, patch: diffPatch(workdir, treeBefore, treeAfter, ignoreGlobs) }
            : contentDiff?.changed
              ? { files: contentDiff.files }
              : undefined,
      });

      // 4) Honest caveats about this iteration.
      const iterWarnings: string[] = [];
      if (driverClaimUnverified) {
        iterWarnings.push(
          "content-hash walk hit the file cap; treating driver-reported changedFiles as the change list (unverified)",
        );
      }
      if (verdict.satisfied && !changed) {
        if (gitEnabled) {
          iterWarnings.push(
            "criteria satisfied but the agent changed no files — this run may not have done any work (checks may be vacuous)",
          );
        } else if (contentFallback) {
          iterWarnings.push(
            "criteria satisfied but no file content changes were detected — this run may not have done any work (checks may be vacuous)",
          );
        } else {
          // Last-resort wording when even content hashing is unavailable.
          iterWarnings.push(
            "criteria satisfied but the driver reported no file changes — this run may not have done any work (checks may be vacuous; change detection is unverified without git)",
          );
        }
      }
      if (verdict.satisfied && (agent.stopReason === "max_turns" || agent.stopReason === "error" || !agent.ok)) {
        iterWarnings.push(
          `criteria satisfied, but the agent did not complete (${agent.stopReason ?? "error"}); success rests on the checks alone`,
        );
      }
      for (const w of iterWarnings) iterLog.warn(w);

      const selfEvalRuns = selfEvalCounts.size ? Object.fromEntries(selfEvalCounts) : undefined;
      if (selfEvalRuns) {
        iterLog.info(
          `agent self-ran grader command(s) during its turn: ${[...selfEvalCounts]
            .map(([n, c]) => `${n} ×${c}`)
            .join(", ")} — inner-loop verification, not the engine's feedback loop`,
        );
      }

      const report: IterationReport = {
        iteration: i,
        agent,
        evaluations,
        satisfied: verdict.satisfied,
        reason: verdict.reason,
        durationMs: Date.now() - iterStart,
        changed,
        changedFiles,
        diffStat: iterDiffStat || undefined,
        selfEvalRuns,
        warnings: iterWarnings,
      };
      iterations.push(report);
      opts.onIteration?.(report);
      for (const s of observerSessions) {
        try {
          s.onIteration?.(report);
        } catch {
          /* an observer must never break a run */
        }
      }
      iterLog.info(`result: ${verdict.satisfied ? "PASS" : "not yet"} — ${verdict.reason}`);

      if (verdict.satisfied) {
        checkSpecTamper();
        checkEvaluatorTamper();
        const overall = this.overallChanges(
          workdir,
          gitEnabled,
          baselineTree,
          lastTree,
          baselineContent,
          lastContent,
          ignoreGlobs,
          overallChangedFiles,
        );
        const warnings = [...runWarnings, ...iterWarnings];
        // Tamper in "error" mode: the agent altered its own success criteria
        // (the spec, or the files an evaluator runs), so a green can't be
        // trusted — fail instead of reporting success. Spec-tamper takes
        // precedence when both fire.
        const specTamperFails = specTampered && specGuard === "error";
        const evalTamperFails = evaluatorTampered && evaluatorGuard === "error";
        const tamperFails = specTamperFails || evalTamperFails;
        const tamperOutcome: LoopOutcome = specTamperFails ? "spec-tampered" : "evaluator-tampered";
        return this.finishObservers(observerSessions, {
          ...base,
          outcome: tamperFails ? tamperOutcome : "success",
          success: !tamperFails,
          reason: specTamperFails
            ? `the agent modified the loop spec file during the run (specGuard: error) — success criteria may have been altered`
            : evalTamperFails
              ? `the agent modified evaluator file(s) during the run (evaluatorGuard: error): ${tamperedEvalFiles.join(", ")} — success checks may have been altered`
              : verdict.reason,
          iterations,
          totalUsage,
          baseline,
          changedFiles: overall.files,
          diffStat: overall.stat || undefined,
          warnings,
          durationMs: Date.now() - start,
        });
      }

      // Budget ceiling: the iteration didn't converge — if cumulative usage has
      // blown the configured cost/token budget, stop now rather than fund
      // another turn. A satisfied iteration above already returned success, so
      // getting the result is never penalized; only further spend is capped.
      const overBudget = budgetExceeded(totalUsage, spec.limits);
      if (overBudget) {
        checkSpecTamper();
        checkEvaluatorTamper();
        iterLog.warn(overBudget);
        const overall = this.overallChanges(
          workdir,
          gitEnabled,
          baselineTree,
          lastTree,
          baselineContent,
          lastContent,
          ignoreGlobs,
          overallChangedFiles,
        );
        return this.finishObservers(observerSessions, {
          ...base,
          outcome: "budget-exceeded",
          success: false,
          reason: overBudget,
          iterations,
          totalUsage,
          baseline,
          changedFiles: overall.files,
          diffStat: overall.stat || undefined,
          warnings: runWarnings,
          durationMs: Date.now() - start,
        });
      }
    }

    checkSpecTamper();
    checkEvaluatorTamper();
    const overall = this.overallChanges(
      workdir,
      gitEnabled,
      baselineTree,
      lastTree,
      baselineContent,
      lastContent,
      ignoreGlobs,
      overallChangedFiles,
    );
    return this.finishObservers(observerSessions, {
      ...base,
      outcome: "max-iterations",
      success: false,
      reason: `exhausted ${maxIterations} iteration(s) without satisfying: ${feedback?.reason ?? "criteria"}`,
      iterations,
      totalUsage,
      baseline,
      changedFiles: overall.files,
      diffStat: overall.stat || undefined,
      warnings: runWarnings,
      durationMs: Date.now() - start,
    });
  }

  /**
   * Whole-run change summary: git tree diff when available, otherwise
   * content-hash baseline→now (or the union of per-iteration files).
   */
  private overallChanges(
    workdir: string,
    gitEnabled: boolean,
    baselineTree: string | null,
    lastTree: string | null,
    baselineContent: ContentSnapshot | null,
    /** End-of-run content snapshot when available (avoids a third full walk). */
    endContent: ContentSnapshot | null,
    ignoreGlobs: string[],
    overallChangedFiles: Set<string>,
  ): TreeDiff {
    if (gitEnabled) return diffTrees(workdir, baselineTree, lastTree, ignoreGlobs);
    if (baselineContent) {
      const now = endContent ?? snapshotContent(workdir, ignoreGlobs);
      const diff = diffContent(baselineContent, now);
      if (diff.changed) return diff;
    }
    const files = [...overallChangedFiles].sort();
    return {
      changed: files.length > 0,
      files,
      stat: files.length ? `${files.length} file(s) changed across run` : "",
    };
  }

  /**
   * Begin a session for each resolved observer. A throwing `begin` is isolated
   * and logged — that observer is simply dropped, never failing the run.
   */
  private beginObservers(
    observers: { observer: Observer; options: Record<string, unknown> }[],
    info: { runId: string; workdir: string; baseDir: string; spec: LoopSpec },
    log: Logger,
  ): ObserverSession[] {
    const sessions: ObserverSession[] = [];
    for (const o of observers) {
      try {
        sessions.push(o.observer.begin({ ...info, log, options: o.options }));
      } catch (err) {
        log.warn(`observer "${o.observer.name}" failed to start: ${(err as Error).message}`);
      }
    }
    return sessions;
  }

  /**
   * Fire `onRunEnd` on each session (awaited, isolated) and return the report
   * unchanged. Awaiting lets an observer flush a network export before the run
   * resolves; isolation keeps a failed flush from ever failing the run.
   */
  private async finishObservers(sessions: ObserverSession[], report: LoopReport): Promise<LoopReport> {
    for (const s of sessions) {
      try {
        await s.onRunEnd?.(report);
      } catch {
        /* an observer must never break a run */
      }
    }
    return report;
  }

  private async runEvaluators(
    evaluators: { name: string; type: string; evaluator: Evaluator; options: Record<string, unknown> }[],
    ctx: {
      runId: string;
      iteration: number;
      workdir: string;
      concurrency: number;
      signal?: AbortSignal;
      log: Logger;
      /** Holdout graders to materialize for the duration of this pass. */
      holdouts?: HoldoutMapping[];
      /** Sink for restore caveats (a displaced destination file, a failed restore). */
      onHoldoutNotes?: (notes: string[]) => void;
    },
  ): Promise<EvaluationResult[]> {
    // Holdout graders exist in the workspace only for the duration of this
    // evaluation pass — materialize before, restore in `finally` so the next
    // agent turn (and every workspace snapshot) never sees them.
    let materialized: ReturnType<typeof materializeHoldouts> | undefined;
    if (ctx.holdouts?.length) {
      try {
        materialized = materializeHoldouts(ctx.holdouts, ctx.workdir);
      } catch (err) {
        // Running the checks without their graders would measure nothing —
        // report every evaluator as failed infrastructure, not as a red check.
        const message = (err as Error).message;
        ctx.log.warn(message);
        return evaluators.map((e) => ({
          name: e.name,
          type: e.type,
          ok: false,
          passed: false,
          feedback: `holdout grader could not be materialized: ${message}`,
          error: message,
          durationMs: 0,
        }));
      }
    }
    try {
      return await this.evaluateAll(evaluators, ctx);
    } finally {
      if (materialized) {
        const notes = materialized.restore();
        if (notes.length) ctx.onHoldoutNotes?.(notes);
      }
    }
  }

  private async evaluateAll(
    evaluators: { name: string; type: string; evaluator: Evaluator; options: Record<string, unknown> }[],
    ctx: { runId: string; iteration: number; workdir: string; concurrency: number; signal?: AbortSignal; log: Logger },
  ): Promise<EvaluationResult[]> {
    // Sequential by default (concurrency: 1) so evaluators sharing external
    // state can't race; order-preserving regardless of the limit.
    return mapWithConcurrency(evaluators, ctx.concurrency, async (e): Promise<EvaluationResult> => {
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
    });
  }
}
