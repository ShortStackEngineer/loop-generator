import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { successCriteriaSchema } from "./criteria";

/**
 * The LoopSpec is the reusable, declarative artifact the generator emits and the
 * runner consumes. `driver.uses`, `evaluators[].uses`, and `task.type` are
 * intentionally plain strings resolved against registries at run time, so the
 * schema never needs to change when you add a new plug-in.
 */

const optionsSchema = z.record(z.string(), z.unknown());

export const specEvaluatorSchema = z.object({
  /** Evaluator type to resolve from the registry. */
  uses: z.string(),
  /** Optional instance alias (so two `command` checks can be named distinctly). */
  as: z.string().optional(),
  options: optionsSchema.default({}),
  /**
   * Files this check depends on, watched by the evaluator-integrity guard
   * (`limits.evaluatorGuard`) in addition to the test files auto-detected from a
   * `command`. Each entry is a workspace-relative path to a file or a directory
   * (directories watch their test-like files recursively). Use this when the
   * check's contract isn't obvious from the command alone.
   */
  guard: z.array(z.string()).optional(),
});

export const loopSpecSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),

    task: z
      .object({ type: z.string().min(1) })
      .catchall(z.unknown())
      .default({ type: "function" }),

    stack: z
      .object({
        language: z.string().min(1),
        framework: z.string().optional(),
        packageManager: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),

    workspace: z
      .object({
        /** Directory the agent edits, relative to the spec file (or --base). */
        dir: z.string().default("."),
        /** `git`: snapshot before the run so failed runs can be inspected/reset. */
        snapshot: z.enum(["none", "git"]).default("none"),
        /**
         * Extra glob patterns to exclude from change detection and diffs, on top
         * of the built-in artifact defaults (logs, tmp, sqlite, build output, …).
         * Keeps runtime churn from masking a no-op or inflating the diff.
         */
        ignore: z.array(z.string()).default([]),
      })
      .default({ dir: ".", snapshot: "none", ignore: [] }),

    requirements: z.string().min(1),

    driver: z.object({
      uses: z.string(),
      options: optionsSchema.default({}),
    }),

    evaluators: z.array(specEvaluatorSchema).default([]),

    success: successCriteriaSchema.default({ type: "all-pass" }),

    limits: z
      .object({
        maxIterations: z.number().int().positive().default(5),
        iterationTimeoutMs: z.number().int().positive().optional(),
        /**
         * Run the evaluators once before any agent work. If they already pass,
         * the checks probably don't verify the requirement. Off by default
         * because checks with side effects (db migrate/seed) would run twice.
         * `"strict"` turns that signal into a hard failure: a passing baseline
         * means the checks are vacuous, so the run fails instead of warning.
         */
        baseline: z.union([z.boolean(), z.literal("strict")]).default(false),
        /**
         * What to do if the agent edits the loop spec file during the run (only
         * watched when the spec lives inside the workspace). `"warn"` (default)
         * surfaces a caveat; `"error"` fails the run so an altered success
         * contract can't report green; `"off"` disables the check.
         */
        specGuard: z.enum(["off", "warn", "error"]).default("warn"),
        /**
         * What to do if the agent edits a file an evaluator depends on (the test
         * files a `command` check runs, plus any `evaluators[].guard` paths). The
         * real success criteria live in those files, so editing them can fake a
         * green. `"warn"` (default) surfaces a caveat; `"error"` fails the run
         * (outcome `evaluator-tampered`); `"off"` disables the check.
         */
        evaluatorGuard: z.enum(["off", "warn", "error"]).default("warn"),
      })
      .default({ maxIterations: 5, baseline: false, specGuard: "warn", evaluatorGuard: "warn" }),

    /**
     * How the engine runs a spec's evaluators. `concurrency` defaults to 1
     * (fully sequential) so checks that share external state — several
     * `bin/rails` checks hitting one database, say — can't race and deadlock
     * into false failures. Raise it only for genuinely independent checks.
     */
    evaluation: z
      .object({ concurrency: z.number().int().positive().default(1) })
      .default({ concurrency: 1 }),

    /** Optional overrides for the task type's generated prompts. */
    prompts: z
      .object({
        system: z.string().optional(),
        initial: z.string().optional(),
        iteration: z.string().optional(),
      })
      .optional(),
  })
  .catchall(z.unknown());

export type LoopSpec = z.infer<typeof loopSpecSchema>;
export type SpecEvaluator = z.infer<typeof specEvaluatorSchema>;

export interface SpecIssue {
  path: PropertyKey[];
  message: string;
}

export class SpecValidationError extends Error {
  constructor(
    message: string,
    readonly issues: SpecIssue[],
  ) {
    super(message);
    this.name = "SpecValidationError";
  }
}

/** Parse + validate an already-loaded object into a LoopSpec. */
export function parseSpec(input: unknown): LoopSpec {
  const result = loopSpecSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues;
    const detail = issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new SpecValidationError(`Invalid loop spec:\n${detail}`, issues);
  }
  return result.data;
}

export interface LoadedSpec {
  spec: LoopSpec;
  /** Absolute path to the spec file. */
  file: string;
  /** Directory the spec's relative paths resolve against. */
  baseDir: string;
}

/** Read and validate a `.loop.yaml` / `.loop.json` file from disk. */
export function loadSpecFile(file: string): LoadedSpec {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`Could not read spec file "${abs}": ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw); // YAML is a superset of JSON, so this handles both.
  } catch (err) {
    throw new Error(`Could not parse "${abs}" as YAML/JSON: ${(err as Error).message}`);
  }
  return { spec: parseSpec(data), file: abs, baseDir: path.dirname(abs) };
}

/** Resolve the absolute workspace directory for a spec. */
export function resolveWorkspaceDir(spec: LoopSpec, baseDir: string): string {
  return path.resolve(baseDir, spec.workspace.dir);
}
