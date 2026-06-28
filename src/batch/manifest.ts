import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loopSpecSchema } from "../core/spec";

/**
 * A batch manifest runs a "punch list" of loop specs — across one or more
 * codebases — with ordering, bounded concurrency, and one aggregate result.
 * Each item points at a `.loop.yaml` file (or inlines a spec) and may override
 * a few run options.
 */
export const batchItemSchema = z
  .object({
    /** Unique identifier for the item (used in `needs` and the report). */
    name: z.string().min(1),
    /** Path to a `.loop.yaml`, relative to the manifest file. */
    spec: z.string().optional(),
    /** Or an inline loop spec instead of a file. */
    inline: loopSpecSchema.optional(),
    /** Override the base dir for this item's relative workspace path. */
    base: z.string().optional(),
    /** Names of items that must succeed before this one runs. */
    needs: z.array(z.string()).default([]),
    /** Per-item overrides. */
    maxIterations: z.number().int().positive().optional(),
    baseline: z.boolean().optional(),
    skipPreflight: z.boolean().optional(),
  })
  .refine((i) => Boolean(i.spec) !== Boolean(i.inline), {
    message: "each item needs exactly one of `spec` or `inline`",
  });

export const batchManifestSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().optional(),
  /** Max items running at once. Same-workspace items never overlap (see runner). */
  concurrency: z.number().int().positive().default(1),
  /** false = stop scheduling new items after the first failure. */
  continueOnError: z.boolean().default(true),
  /** Defaults merged into every item (item-level values win). */
  defaults: z
    .object({
      base: z.string().optional(),
      maxIterations: z.number().int().positive().optional(),
      baseline: z.boolean().optional(),
      skipPreflight: z.boolean().optional(),
    })
    .optional(),
  items: z.array(batchItemSchema).min(1),
});

export type BatchManifest = z.infer<typeof batchManifestSchema>;
export type BatchItem = z.infer<typeof batchItemSchema>;

export class BatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchValidationError";
  }
}

/** Cross-item checks zod can't express: unique names, valid `needs`, no cycles. */
export function validateBatchManifest(manifest: BatchManifest): string[] {
  const errors: string[] = [];
  const names = manifest.items.map((i) => i.name);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) errors.push(`duplicate item name: "${n}"`);
    seen.add(n);
  }

  for (const item of manifest.items) {
    for (const dep of item.needs) {
      if (!seen.has(dep)) errors.push(`item "${item.name}" needs unknown item "${dep}"`);
      if (dep === item.name) errors.push(`item "${item.name}" cannot depend on itself`);
    }
  }

  // Cycle detection via DFS over the needs graph.
  const graph = new Map(manifest.items.map((i) => [i.name, i.needs.filter((d) => seen.has(d))]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): boolean => {
    const s = state.get(node);
    if (s === "done") return false;
    if (s === "visiting") {
      const cycleFrom = stack.slice(stack.indexOf(node));
      errors.push(`dependency cycle: ${[...cycleFrom, node].join(" → ")}`);
      return true;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (visit(dep)) {
        stack.pop();
        state.set(node, "done");
        return true;
      }
    }
    stack.pop();
    state.set(node, "done");
    return false;
  };
  for (const n of names) if (state.get(n) !== "done") visit(n);

  return [...new Set(errors)];
}

export function parseBatchManifest(input: unknown): BatchManifest {
  const result = batchManifestSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new BatchValidationError(`Invalid batch manifest:\n${detail}`);
  }
  const semantic = validateBatchManifest(result.data);
  if (semantic.length) {
    throw new BatchValidationError(`Invalid batch manifest:\n${semantic.map((e) => `  • ${e}`).join("\n")}`);
  }
  return result.data;
}

export interface LoadedBatch {
  manifest: BatchManifest;
  file: string;
  /** Directory the manifest's relative `spec`/`base` paths resolve against. */
  baseDir: string;
}

export function loadBatchFile(file: string): LoadedBatch {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`Could not read batch file "${abs}": ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new Error(`Could not parse "${abs}" as YAML/JSON: ${(err as Error).message}`);
  }
  return { manifest: parseBatchManifest(data), file: abs, baseDir: path.dirname(abs) };
}
