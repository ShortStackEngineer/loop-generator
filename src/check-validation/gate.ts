import path from "node:path";
import type { SpecEvaluator } from "../core/spec";
import { bindManifestChecks, unmappedEvaluatorsWarning } from "./bind";
import {
  captureCheckValidationInputs,
  publicCheckValidationInputs,
  readBoundedFile,
  verifyCheckValidationInputs,
  type CheckValidationInputs,
  type CheckValidationInventory,
} from "./inventory";
import { loadChecksFromContents } from "./manifest";
import { runCheckValidation, type CheckValidationReport } from "./runner";

export type CheckValidationGateStatus = "ok" | "failed" | "aborted" | "tampered";

export interface CheckValidationGate {
  status: CheckValidationGateStatus;
  reason?: string;
  report?: CheckValidationReport;
  inputs?: CheckValidationInputs;
  unmappedEvaluators: string[];
  unmappedWarning?: string;
  inventory?: CheckValidationInventory;
}

export interface RunCheckValidationGateOptions {
  /** Absolute or relative manifest path; relative resolves against `baseDir`. */
  manifest: string;
  /** `RunOptions.baseDir` — where the loop spec's relative paths resolve. */
  baseDir: string;
  evaluators: readonly SpecEvaluator[];
  signal?: AbortSignal;
}

function failed(reason: string, extra: Partial<CheckValidationGate> = {}): CheckValidationGate {
  return { status: "failed", reason, unmappedEvaluators: extra.unmappedEvaluators ?? [], ...extra };
}

function aborted(extra: Partial<CheckValidationGate> = {}): CheckValidationGate {
  return { status: "aborted", reason: "run aborted", unmappedEvaluators: extra.unmappedEvaluators ?? [], ...extra };
}

function failureReasonFromReport(report: CheckValidationReport): string {
  const notes: string[] = [];
  for (const r of report.control) {
    if (r.status !== "passed") notes.push(`control check "${r.check}" ${r.status}`);
  }
  for (const ce of report.counterexamples) {
    if (ce.status === "escaped") {
      notes.push(`counterexample "${ce.id}" escaped`);
    } else if (ce.status === "error") {
      notes.push(`counterexample "${ce.id}" errored`);
    }
  }
  for (const c of report.claims) {
    if (c.status === "gap" && !c.escaped?.length) {
      notes.push(`claim "${c.id}" has no mapped counterexample`);
    }
  }
  const detail = notes.length ? `: ${notes.join("; ")}` : "";
  return `check validation did not succeed (outcome: ${report.outcome})${detail}`;
}

function withProvenance(
  gate: Omit<CheckValidationGate, "unmappedEvaluators" | "unmappedWarning" | "inventory" | "inputs">,
  inventory: CheckValidationInventory | undefined,
  unmapped: string[],
): CheckValidationGate {
  return {
    ...gate,
    unmappedEvaluators: unmapped,
    unmappedWarning: unmapped.length ? unmappedEvaluatorsWarning(unmapped) : undefined,
    inventory,
    inputs: inventory ? publicCheckValidationInputs(inventory) : undefined,
  };
}

/**
 * Load, bind, inventory, and run check validation for an ordinary loop.
 * Does not invoke the agent. Callers must not skip this when the spec opts in.
 */
export async function runCheckValidationGate(
  opts: RunCheckValidationGateOptions,
): Promise<CheckValidationGate> {
  if (opts.signal?.aborted) return aborted();

  const absManifest = path.resolve(opts.baseDir, opts.manifest);
  // Bounded read *before* parsing so size limits apply to the bytes we parse,
  // and so we can later prove the inventory hash is those same bytes.
  const firstRead = readBoundedFile(absManifest);
  if (!firstRead.ok) {
    return failed(`check validation: cannot read manifest: ${firstRead.reason}`);
  }

  let loaded;
  try {
    loaded = loadChecksFromContents(firstRead.buffer.toString("utf8"), absManifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failed(`check validation: ${message}`);
  }

  const binding = bindManifestChecks(loaded.manifest, opts.evaluators);
  if (binding.errors.length) {
    return failed(binding.errors.join("\n"), { unmappedEvaluators: binding.unmapped });
  }

  if (opts.signal?.aborted) return aborted({ unmappedEvaluators: binding.unmapped });

  const captured = captureCheckValidationInputs(loaded.file, loaded.manifest, loaded.baseDir);
  if (!captured.ok) {
    return failed(captured.reason, { unmappedEvaluators: binding.unmapped });
  }

  const capturedHash = captured.inventory.hashes[captured.inventory.manifest];
  if (capturedHash !== firstRead.hash) {
    // Parsed bytes and the post-parse inventory disagree — a change landed
    // between load and capture. Do not run checks or attach the later hash.
    return failed(
      "check validation: manifest content changed between parse and inventory capture — refusing to run checks against disagreeing inputs",
      { unmappedEvaluators: binding.unmapped },
    );
  }

  if (opts.signal?.aborted) {
    return withProvenance(aborted(), captured.inventory, binding.unmapped);
  }

  let report: CheckValidationReport;
  try {
    report = await runCheckValidation(loaded.manifest, {
      baseDir: loaded.baseDir,
      signal: opts.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.signal?.aborted || /abort/i.test(message)) {
      return withProvenance(aborted(), captured.inventory, binding.unmapped);
    }
    return withProvenance(failed(`check validation: ${message}`), captured.inventory, binding.unmapped);
  }

  if (opts.signal?.aborted) {
    return withProvenance({ status: "aborted", reason: "run aborted", report }, captured.inventory, binding.unmapped);
  }

  const after = verifyCheckValidationInputs(captured.inventory);
  if (!after.ok) {
    return withProvenance(
      { status: "tampered", reason: after.reason, report },
      captured.inventory,
      binding.unmapped,
    );
  }

  if (report.outcome !== "validated") {
    return withProvenance(failed(failureReasonFromReport(report), { report }), captured.inventory, binding.unmapped);
  }

  return withProvenance({ status: "ok", report }, captured.inventory, binding.unmapped);
}
