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
      })
      .default({ dir: ".", snapshot: "none" }),

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
      })
      .default({ maxIterations: 5 }),

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
