import path from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseSpec, resolveWorkspaceDir } from "../core/spec";
import { parseBatchManifest, validateBatchManifest, type BatchManifest } from "../batch/manifest";
import { resolveItem, type ResolvedItem } from "../batch/runner";
import type { LintFinding } from "./types";
import { lintSpec, workspacePreflight } from "./spec-lint";

export type { LintFinding, LintSeverity } from "./types";
export { lintSpec, workspacePreflight } from "./spec-lint";

// Batch findings carry prose messages/hints and rule-id constants (data, not
// control flow); the scheduling/override *logic* is what the tests pin.
// Stryker disable StringLiteral
/** Batch-structure rules + every item's spec rules (with resolved workdirs). */
export function lintBatch(
  manifest: BatchManifest,
  ctx: { baseDir: string; file?: string },
): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const msg of validateBatchManifest(manifest)) {
    findings.push({ ruleId: "BATCH-INVALID", severity: "error", message: msg });
  }

  // Resolve each item the same way the runner does (so workdirs match reality).
  const resolved = new Map<string, ResolvedItem>();
  for (const item of manifest.items) {
    try {
      resolved.set(item.name, resolveItem(item, manifest, ctx.baseDir));
    } catch (err) {
      findings.push({
        ruleId: "BATCH-SPEC-LOAD",
        severity: "error",
        message: `item "${item.name}": ${(err as Error).message}`,
        item: item.name,
      });
    }
  }

  findings.push(...batchRules(manifest, resolved));

  for (const item of manifest.items) {
    const r = resolved.get(item.name);
    if (!r) continue;
    for (const f of lintSpec(r.spec, { workdir: r.workspace, file: r.specFile })) {
      findings.push({ ...f, item: item.name });
    }
  }

  return findings;
}

function batchRules(manifest: BatchManifest, resolved: Map<string, ResolvedItem>): LintFinding[] {
  const findings: LintFinding[] = [];
  const items = manifest.items;

  // BATCH-MAXITER-OVERRIDE: a batch default silently beats a spec's own value.
  const dflt = manifest.defaults?.maxIterations;
  if (dflt != null) {
    for (const item of items) {
      const r = resolved.get(item.name);
      if (!r) continue;
      if (item.maxIterations == null && r.spec.limits.maxIterations !== dflt) {
        findings.push({
          ruleId: "BATCH-MAXITER-OVERRIDE",
          severity: "warn",
          message: `item "${item.name}": batch defaults.maxIterations=${dflt} overrides the spec's limits.maxIterations=${r.spec.limits.maxIterations}`,
          item: item.name,
          path: "defaults.maxIterations",
          hint: "Set the item's maxIterations explicitly, or align the spec and the batch default.",
        });
      }
    }
  }

  // BATCH-NEEDS-AS-ORDERING: same workspace + concurrency 1 already serialize.
  const workspaces = items.map((i) => resolved.get(i.name)?.workspace).filter(Boolean) as string[];
  const concurrency = manifest.concurrency ?? 1;
  const anyNeeds = items.some((i) => (i.needs?.length ?? 0) > 0);
  if (
    items.length >= 2 &&
    workspaces.length === items.length &&
    new Set(workspaces).size === 1 &&
    concurrency === 1 &&
    anyNeeds
  ) {
    findings.push({
      ruleId: "BATCH-NEEDS-AS-ORDERING",
      severity: "warn",
      message:
        "all items share one workspace at concurrency 1, so they already run sequentially; the `needs` chain only adds failure-cascading",
      path: "items[].needs",
      hint: "Drop spurious `needs` (keep real data deps) or set continueOnError: true so independent items still run.",
    });
  }

  // BATCH-FAILFAST-CHAIN: continueOnError:false skips everything after one failure.
  if (manifest.continueOnError === false && items.length >= 2) {
    findings.push({
      ruleId: "BATCH-FAILFAST-CHAIN",
      severity: "warn",
      message: `continueOnError is false — the first failure skips all not-yet-started items (up to ${items.length - 1})`,
      path: "continueOnError",
      hint: "Set continueOnError: true to attempt independent items even after one fails.",
    });
  }

  return findings;
}
// Stryker restore StringLiteral

export interface LintResult {
  kind: "spec" | "batch";
  findings: LintFinding[];
}

/** Load a `.loop.yaml` or `.batch.yaml` from disk and lint it. */
export function lintPath(file: string, opts: { base?: string } = {}): LintResult {
  const abs = path.resolve(file);
  const raw = readFileSync(abs, "utf8");
  const data = parseYaml(raw) as unknown;
  const dir = path.dirname(abs);

  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    const manifest = parseBatchManifest(data);
    return { kind: "batch", findings: lintBatch(manifest, { baseDir: dir, file: abs }) };
  }

  const spec = parseSpec(data);
  const base = opts.base ? path.resolve(opts.base) : dir;
  const workdir = resolveWorkspaceDir(spec, base);
  return { kind: "spec", findings: lintSpec(spec, { workdir, file: abs }) };
}
