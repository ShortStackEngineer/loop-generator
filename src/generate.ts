import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { genericTask } from "./tasks/builtin";
import { createTaskRegistry, createEvaluatorRegistry } from "./registry";
import { loopSpecSchema, type LoopSpec, type SpecEvaluator } from "./core/spec";
import type { SuccessCriteria } from "./core/criteria";
import type { Registry } from "./core/registry";
import type { Evaluator } from "./evaluators/types";
import { silentLogger, type Logger } from "./core/logger";
import { lintSpec, defaultKnownPlugins, type LintFinding } from "./lint";

export interface GenerateInput {
  name: string;
  /** Task category; resolved against the task registry for recommended checks. */
  taskType: string;
  language: string;
  framework?: string;
  packageManager?: string;
  requirements: string;
  description?: string;
  /** Driver to invoke each iteration (default: claude-agent-sdk). */
  driver?: string;
  driverOptions?: Record<string, unknown>;
  /** Override the auto-recommended evaluators. */
  evaluators?: SpecEvaluator[];
  success?: SuccessCriteria;
  maxIterations?: number;
  workspaceDir?: string;
}

/**
 * Headless-safe option seeds written into a generated spec so the YAML shows
 * the flags an unattended loop actually needs. Unknown drivers get `{}`.
 */
export function defaultDriverOptions(driver: string): Record<string, unknown> {
  switch (driver) {
    case "opencode":
      return { dangerouslySkipPermissions: true };
    default:
      return {};
  }
}

/**
 * Produce a validated LoopSpec from high-level inputs. Evaluators default to the
 * task type's recommendations for the chosen language, so the generated loop is
 * runnable with minimal input.
 */
export function generateSpec(input: GenerateInput): LoopSpec {
  const tasks = createTaskRegistry();
  const taskType = tasks.tryGet(input.taskType) ?? genericTask;

  const draft = {
    version: 1 as const,
    name: input.name,
    description: input.description,
    task: { type: input.taskType },
    stack: {
      language: input.language,
      framework: input.framework,
      packageManager: input.packageManager,
    },
    // Safer-by-default posture (matches the project's trust philosophy):
    //  - snapshot "git" keeps git-backed change detection on, so a green run that
    //    changed nothing is caught. Overridable to "none" for non-git workspaces.
    workspace: { dir: input.workspaceDir ?? ".", snapshot: "git" as const },
    requirements: input.requirements,
    driver: {
      uses: input.driver ?? "claude-agent-sdk",
      options: {
        ...defaultDriverOptions(input.driver ?? "claude-agent-sdk"),
        ...(input.driverOptions ?? {}),
      },
    },
    evaluators:
      input.evaluators ??
      taskType.recommendedEvaluators(
        // recommendedEvaluators only reads stack + evaluators; a partial spec is fine.
        { stack: { language: input.language, framework: input.framework } } as LoopSpec,
      ),
    success: input.success ?? ({ type: "all-pass" } as SuccessCriteria),
    // baseline: true runs the checks once before any agent work, so a freshly
    // generated spec surfaces the vacuous-baseline smell (checks that already
    // pass) instead of silently reporting a green that proves nothing.
    limits: { maxIterations: input.maxIterations ?? 5, baseline: true as const },
  };

  // Round-trip through the schema so generated specs are always valid + defaulted.
  return loopSpecSchema.parse(draft);
}

const HEADER = `# loop-generator spec — see https://github.com (project README) for the schema.
# Run with:  loopgen run <this-file>
# Edit 'requirements', the 'evaluators' (your feedback tools), and 'success' criteria.
`;

/** Serialize a spec to commented YAML ready to write to disk. */
export function specToYaml(spec: LoopSpec): string {
  return `${HEADER}\n${stringifyYaml(spec, { lineWidth: 0 })}`;
}

/** One evaluator's outcome from a standalone RED check. */
export interface RedCheckEvaluation {
  /** Instance name: the spec's `as`, falling back to `uses`. */
  name: string;
  /** The evaluator type (`uses`). */
  type: string;
  /** Did the check meet its bar? */
  passed: boolean;
  /** False if the evaluator could not run at all (missing binary, unknown type). */
  ok: boolean;
  /** Human/agent-readable feedback (or the error, when it couldn't run). */
  feedback: string;
  error?: string;
}

export interface RedCheckResult {
  /**
   * True when at least one evaluator did NOT pass — i.e. the checks start RED,
   * as an unmet requirement should. False means the checks are already GREEN
   * (the vacuous-baseline smell) or there was nothing to run.
   */
  startsRed: boolean;
  /** True when the spec declares no evaluators, so RED can't be proven. */
  noEvaluators: boolean;
  evaluations: RedCheckEvaluation[];
}

export interface RedCheckOptions {
  /** Absolute path to the workspace to evaluate against. */
  workdir: string;
  /** Evaluator registry to resolve `evaluators[].uses` (defaults to built-ins). */
  registry?: Registry<Evaluator>;
  signal?: AbortSignal;
  log?: Logger;
}

/**
 * Run a spec's evaluators exactly once against the workspace, with NO agent work
 * and NO driver, to prove the checks start RED. This mirrors the engine's
 * baseline evaluation (iteration -1, resolved via the evaluator registry) but
 * spins up no agent — a zero-agent-turn check suitable for `generate --verify`.
 *
 * Evaluators run sequentially (like the engine's default concurrency of 1) so
 * checks sharing external state can't race. An evaluator that throws or can't be
 * resolved is recorded as `ok: false` and, being non-passing, still contributes
 * to a RED result — but the caller can inspect `ok` to surface a misconfiguration.
 */
export async function runRedCheck(spec: LoopSpec, opts: RedCheckOptions): Promise<RedCheckResult> {
  const registry = opts.registry ?? createEvaluatorRegistry();
  const log = opts.log ?? silentLogger;
  const runId = randomUUID();
  const evaluations: RedCheckEvaluation[] = [];

  for (const e of spec.evaluators) {
    const name = e.as ?? e.uses;
    const type = e.uses;

    let evaluator: Evaluator;
    try {
      evaluator = registry.get(e.uses);
    } catch (err) {
      evaluations.push({ name, type, passed: false, ok: false, feedback: (err as Error).message, error: (err as Error).message });
      continue;
    }

    try {
      const outcome = await evaluator.evaluate({
        runId,
        iteration: -1,
        workdir: opts.workdir,
        options: e.options,
        signal: opts.signal,
        log: log.child(name),
      });
      evaluations.push({
        name,
        type,
        passed: outcome.passed,
        ok: outcome.ok ?? true,
        feedback: outcome.feedback,
        error: outcome.error,
      });
    } catch (err) {
      evaluations.push({
        name,
        type,
        passed: false,
        ok: false,
        feedback: `Evaluator threw: ${(err as Error).message}`,
        error: (err as Error).message,
      });
    }
  }

  const noEvaluators = evaluations.length === 0;
  const startsRed = !noEvaluators && evaluations.some((r) => !r.passed);
  return { startsRed, noEvaluators, evaluations };
}

export interface VerifyResult {
  lint: LintFinding[];
  lintErrors: number;
  lintWarnings: number;
  red: RedCheckResult;
  /**
   * Overall verdict: no lint errors (and, with `strict`, no lint warnings) AND
   * the checks start RED. False means the spec isn't ready to run as authored.
   */
  ok: boolean;
}

export interface VerifyOptions extends RedCheckOptions {
  /** Absolute path to the spec file on disk (drives lint path-resolution + rules). */
  file?: string;
  /** Treat lint warnings as failures too (mirrors `loopgen lint --strict`). */
  strict?: boolean;
}

/**
 * Encode the author-loop contract: statically lint the spec AND prove its checks
 * start RED before any agent work. Reuses the same lint rules as `loopgen lint`
 * and the standalone {@link runRedCheck}; runs no driver. The CLI's
 * `generate --verify` is a thin wrapper over this.
 */
export async function verifySpec(spec: LoopSpec, opts: VerifyOptions): Promise<VerifyResult> {
  const lint = lintSpec(spec, { workdir: opts.workdir, file: opts.file, known: defaultKnownPlugins() });
  const lintErrors = lint.filter((f) => f.severity === "error").length;
  const lintWarnings = lint.filter((f) => f.severity === "warn").length;
  const red = await runRedCheck(spec, opts);
  const lintOk = lintErrors === 0 && !(opts.strict === true && lintWarnings > 0);
  return { lint, lintErrors, lintWarnings, red, ok: lintOk && red.startsRed };
}
