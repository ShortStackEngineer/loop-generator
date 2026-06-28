import path from "node:path";
import { loadSpecFile, resolveWorkspaceDir, type LoopSpec } from "../core/spec";
import { LoopEngine, type LoopReport } from "../core/engine";
import type { AgentUsage } from "../drivers/types";
import { addUsage } from "../core/usage";
import { createLogger, type Logger } from "../core/logger";
import type { BatchItem, BatchManifest } from "./manifest";
import { validateBatchManifest, BatchValidationError } from "./manifest";

export type BatchItemStatus = "success" | "failed" | "skipped" | "error";

export interface BatchItemResult {
  name: string;
  status: BatchItemStatus;
  /** The loop report (absent when skipped, or when resolution errored before a run). */
  report?: LoopReport;
  reason: string;
  durationMs: number;
}

export interface BatchReport {
  name?: string;
  success: boolean;
  items: BatchItemResult[];
  counts: Record<BatchItemStatus, number> & { total: number };
  totalUsage: AgentUsage;
  durationMs: number;
}

export interface RunBatchOptions {
  /** Directory the manifest's relative `spec`/`base` paths resolve against. */
  baseDir: string;
  signal?: AbortSignal;
  log?: Logger;
  /** Called when an item finishes (any terminal status). */
  onItem?: (result: BatchItemResult) => void;
  /** Called just before an item's loop starts running. */
  onItemStart?: (name: string) => void;
  /** Override manifest concurrency / continueOnError. */
  concurrency?: number;
  continueOnError?: boolean;
  /** Override every item's iteration budget (wins over item/defaults). */
  maxIterations?: number;
}

interface ResolvedItem {
  spec: LoopSpec;
  specFile?: string;
  baseDir: string;
  workspace: string;
  maxIterations?: number;
  baseline?: boolean;
  skipPreflight?: boolean;
}

/**
 * Resolve an item's spec (from a file or inline) and its effective run options.
 * Does not mutate the loaded/parsed spec — the iteration budget is passed to the
 * engine as an override, so re-running a manifest is side-effect free.
 */
function resolveItem(item: BatchItem, manifest: BatchManifest, manifestDir: string): ResolvedItem {
  let spec: LoopSpec;
  let specFile: string | undefined;
  let specBaseDir: string;
  if (item.spec) {
    const loaded = loadSpecFile(path.resolve(manifestDir, item.spec));
    spec = loaded.spec;
    specFile = loaded.file;
    specBaseDir = loaded.baseDir;
  } else {
    spec = item.inline!;
    specBaseDir = manifestDir;
  }

  const base = item.base ?? manifest.defaults?.base;
  const baseDir = base ? path.resolve(manifestDir, base) : specBaseDir;

  return {
    spec,
    specFile,
    baseDir,
    workspace: resolveWorkspaceDir(spec, baseDir),
    maxIterations: item.maxIterations ?? manifest.defaults?.maxIterations,
    baseline: item.baseline ?? manifest.defaults?.baseline,
    skipPreflight: item.skipPreflight ?? manifest.defaults?.skipPreflight,
  };
}

/**
 * Execute a batch manifest: schedule items respecting `needs` ordering and a
 * concurrency cap, while guaranteeing two items that resolve to the **same
 * workspace never run at once** (so parallelism is safe across distinct repos
 * without clobbering one). Failed/skipped dependencies cascade to dependents.
 */
export async function runBatch(
  manifest: BatchManifest,
  engine: LoopEngine,
  opts: RunBatchOptions,
): Promise<BatchReport> {
  const log = opts.log ?? createLogger("info", "batch");
  const start = Date.now();

  const semantic = validateBatchManifest(manifest);
  if (semantic.length) throw new BatchValidationError(semantic.join("; "));

  const concurrency = opts.concurrency ?? manifest.concurrency;
  const continueOnError = opts.continueOnError ?? manifest.continueOnError;

  const results = new Map<string, BatchItemResult>();
  const pending = new Set(manifest.items.map((i) => i.name));
  const inflight = new Map<string, Promise<BatchItemResult>>();
  const busyWorkspaces = new Set<string>();
  let stopNew = false;

  const finish = (r: BatchItemResult): void => {
    results.set(r.name, r);
    pending.delete(r.name);
    opts.onItem?.(r);
  };

  // Resolve every item up front so workspaces are known before scheduling.
  // Resolution failures (e.g. a missing `spec:` file) are recorded as terminal
  // "error" results immediately — before scheduling — so dependents correctly
  // see a dead dependency regardless of manifest order.
  const resolved = new Map<string, ResolvedItem>();
  for (const item of manifest.items) {
    try {
      resolved.set(item.name, resolveItem(item, manifest, opts.baseDir));
    } catch (err) {
      finish({ name: item.name, status: "error", reason: (err as Error).message, durationMs: 0 });
    }
  }

  // status of an item's dependencies: every dep must have a result, all success.
  const depsState = (item: BatchItem): "ready" | "blocked" | "deadDep" => {
    for (const dep of item.needs) {
      const r = results.get(dep);
      if (!r) return "blocked";
      if (r.status !== "success") return "deadDep";
    }
    return "ready";
  };

  const runItem = async (item: BatchItem, r: ResolvedItem): Promise<BatchItemResult> => {
    const itemStart = Date.now();
    opts.onItemStart?.(item.name);
    try {
      const report = await engine.run(r.spec, {
        baseDir: r.baseDir,
        specFile: r.specFile,
        maxIterations: opts.maxIterations ?? r.maxIterations,
        baseline: r.baseline,
        skipPreflight: r.skipPreflight,
        signal: opts.signal,
        log: log.child(item.name),
      });
      return {
        name: item.name,
        status: report.success ? "success" : "failed",
        report,
        reason: report.reason,
        durationMs: Date.now() - itemStart,
      };
    } catch (err) {
      return { name: item.name, status: "error", reason: (err as Error).message, durationMs: Date.now() - itemStart };
    }
  };

  while (pending.size > 0 || inflight.size > 0) {
    if (opts.signal?.aborted) stopNew = true;

    // Schedule whatever can start now.
    for (const item of manifest.items) {
      if (!pending.has(item.name) || inflight.has(item.name)) continue;

      const state = depsState(item);
      if (state === "deadDep") {
        const failedDep = item.needs.find((d) => results.get(d)?.status !== "success");
        finish({ name: item.name, status: "skipped", reason: `dependency "${failedDep}" did not succeed`, durationMs: 0 });
        continue;
      }
      if (state === "blocked") continue;
      if (stopNew) continue;
      if (inflight.size >= concurrency) break;

      const r = resolved.get(item.name)!;
      if (busyWorkspaces.has(r.workspace)) continue; // same-workspace exclusivity

      busyWorkspaces.add(r.workspace);
      pending.delete(item.name);
      const promise = runItem(item, r).finally(() => busyWorkspaces.delete(r.workspace));
      inflight.set(item.name, promise);
    }

    if (inflight.size === 0) {
      // Nothing running and nothing newly schedulable. With resolve-errors and
      // dead deps already handled above, the remainder are ready items held back
      // by a stop (failure / abort) — skip them.
      for (const name of pending) {
        finish({ name, status: "skipped", reason: "batch stopped before this item ran", durationMs: 0 });
      }
      break;
    }

    const done = await Promise.race(inflight.values());
    inflight.delete(done.name);
    finish(done);
    if (done.status !== "success" && !continueOnError) stopNew = true;
  }

  // Preserve manifest order in the report.
  const items = manifest.items.map((i) => results.get(i.name)!);
  const counts = { success: 0, failed: 0, skipped: 0, error: 0, total: items.length } as BatchReport["counts"];
  let totalUsage: AgentUsage = {};
  for (const r of items) {
    counts[r.status] += 1;
    if (r.report) totalUsage = addUsage(totalUsage, r.report.totalUsage);
  }

  return {
    name: manifest.name,
    success: counts.success === counts.total,
    items,
    counts,
    totalUsage,
    durationMs: Date.now() - start,
  };
}
