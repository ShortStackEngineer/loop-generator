import { stringify as stringifyYaml } from "yaml";
import { genericTask } from "./tasks/builtin";
import { createTaskRegistry } from "./registry";
import { loopSpecSchema, type LoopSpec, type SpecEvaluator } from "./core/spec";
import type { SuccessCriteria } from "./core/criteria";

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
    workspace: { dir: input.workspaceDir ?? ".", snapshot: "none" as const },
    requirements: input.requirements,
    driver: {
      uses: input.driver ?? "claude-agent-sdk",
      options: input.driverOptions ?? {},
    },
    evaluators:
      input.evaluators ??
      taskType.recommendedEvaluators(
        // recommendedEvaluators only reads stack + evaluators; a partial spec is fine.
        { stack: { language: input.language, framework: input.framework } } as LoopSpec,
      ),
    success: input.success ?? ({ type: "all-pass" } as SuccessCriteria),
    limits: { maxIterations: input.maxIterations ?? 5 },
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
