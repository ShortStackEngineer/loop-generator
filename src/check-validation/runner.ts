import path from "node:path";
import { tail } from "../core/exec";
import {
  classifyCheckExecution,
  classifyClaim,
  classifyCounterexample,
  classifyOutcome,
  controlPassed,
  type CheckRunResult,
  type CheckValidationReport,
  type ClaimReport,
  type CounterexampleReport,
} from "./aggregate";
import { runCheckCommand } from "./exec";
import { FixtureError, inspectFixture, withIsolatedFixture } from "./fixtures";
import type { CheckSpec, ChecksManifest } from "./manifest";

export type { CheckRunResult, CheckValidationReport, ClaimReport, CounterexampleReport };
export type {
  CheckRunStatus,
  CheckValidationOutcome,
  ClaimStatus,
  CounterexampleStatus,
} from "./aggregate";
export {
  checkValidationExitCode,
  classifyCheckExecution,
  classifyCounterexample,
  classifyClaim,
  classifyOutcome,
  controlPassed,
} from "./aggregate";

const DEFAULT_FEEDBACK_CHARS = 3_000;

export interface RunCheckValidationOptions {
  /**
   * Directory relative fixture paths resolve against. Independent of the
   * process cwd — typically the directory of the manifest file.
   */
  baseDir: string;
  signal?: AbortSignal;
  /** Trailing chars of command output kept in `feedback`. Default 3000. */
  feedbackChars?: number;
}

function formatFeedback(
  command: string,
  result: {
    timedOut: boolean;
    aborted?: boolean;
    code: number | null;
    signal: NodeJS.Signals | null;
    combined: string;
  },
  status: CheckRunResult["status"],
  maxChars: number,
): string {
  const exitLabel = result.timedOut
    ? "TIMED OUT"
    : result.aborted
      ? "ABORTED"
      : result.code === null
        ? `killed${result.signal ? ` (signal ${result.signal})` : ""}`
        : `exit ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}`;
  const mark = status === "passed" ? "✓" : status === "rejected" ? "✗" : "!";
  const lines = [`\`${command}\` → ${exitLabel} ${mark}`];
  if (status !== "passed") {
    lines.push("", "output:", tail(result.combined.trim() || "(no output)", maxChars));
  }
  return lines.join("\n");
}

function errorResult(checkId: string, feedback: string): CheckRunResult {
  return { check: checkId, status: "error", exitCode: null, feedback };
}

function abortedResult(checkId: string): CheckRunResult {
  return errorResult(checkId, "aborted");
}

async function runIsolatedCheck(
  check: CheckSpec,
  sourceDir: string,
  label: string,
  opts: { signal?: AbortSignal; feedbackChars: number },
): Promise<CheckRunResult> {
  if (opts.signal?.aborted) return abortedResult(check.id);

  try {
    return await withIsolatedFixture(sourceDir, label, async (cwd) => {
      if (opts.signal?.aborted) return abortedResult(check.id);
      try {
        const result = await runCheckCommand(check.command, {
          cwd,
          timeoutMs: check.timeoutMs,
          signal: opts.signal,
        });
        const status = classifyCheckExecution({
          code: result.code,
          timedOut: result.timedOut,
          aborted: result.aborted || opts.signal?.aborted === true,
          rejectExitCodes: check.rejectExitCodes,
        });
        return {
          check: check.id,
          status,
          exitCode: result.code,
          feedback: formatFeedback(check.command, result, status, opts.feedbackChars),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = opts.signal?.aborted === true || /abort/i.test(message);
        return {
          check: check.id,
          status: "error",
          exitCode: null,
          feedback: aborted ? `aborted: ${message}` : `Could not run \`${check.command}\`: ${message}`,
        };
      }
    });
  } catch (err) {
    const message = err instanceof FixtureError || err instanceof Error ? err.message : String(err);
    return errorResult(check.id, message);
  }
}

async function runChecksOnFixture(
  checks: readonly CheckSpec[],
  sourceDir: string,
  label: string,
  opts: { signal?: AbortSignal; feedbackChars: number },
): Promise<CheckRunResult[]> {
  const problem = inspectFixture(sourceDir, label);
  if (problem) return checks.map((c) => errorResult(c.id, problem));

  const results: CheckRunResult[] = [];
  for (const check of checks) {
    if (opts.signal?.aborted) {
      results.push(abortedResult(check.id));
      continue;
    }
    results.push(await runIsolatedCheck(check, sourceDir, label, opts));
  }
  return results;
}

function claimsUnvalidated(manifest: ChecksManifest): ClaimReport[] {
  return manifest.claims.map((c) => ({
    id: c.id,
    description: c.description,
    status: "error",
  }));
}

function mappedCheckIds(manifest: ChecksManifest, claimId: string): string[] {
  const claim = manifest.claims.find((c) => c.id === claimId);
  return claim?.checks ?? [];
}

/**
 * Run every check against the control fixture, then (only if the control
 * passed) against each counterexample. Each control/check and
 * counterexample/check pair gets its own fresh recursive copy of the fixture
 * directory (not one shared copy); source fixtures are never modified.
 *
 * Manifests are trusted executable input: check commands run in a shell. The
 * temp copies isolate relative file writes, not arbitrary process behavior.
 * Timeout/abort kill the ordinary process group (POSIX) or process tree
 * (Windows); that is not a sandbox against children that leave the group.
 */
export async function runCheckValidation(
  manifest: ChecksManifest,
  options: RunCheckValidationOptions,
): Promise<CheckValidationReport> {
  const feedbackChars = options.feedbackChars ?? DEFAULT_FEEDBACK_CHARS;
  const runOpts = { signal: options.signal, feedbackChars };
  const controlDir = path.resolve(options.baseDir, manifest.control.dir);

  const control = await runChecksOnFixture(manifest.checks, controlDir, "control", runOpts);

  if (!controlPassed(control)) {
    return {
      name: manifest.name,
      goal: manifest.goal,
      assumptions: manifest.assumptions,
      gaps: manifest.gaps,
      outcome: "error",
      control,
      counterexamples: [],
      claims: claimsUnvalidated(manifest),
    };
  }

  const counterexamples: CounterexampleReport[] = [];
  for (const ce of manifest.counterexamples) {
    const dir = path.resolve(options.baseDir, ce.dir);
    const checks = await runChecksOnFixture(manifest.checks, dir, `counterexample "${ce.id}"`, runOpts);
    const status = classifyCounterexample(checks, mappedCheckIds(manifest, ce.claim));
    counterexamples.push({ id: ce.id, claim: ce.claim, status, checks });
  }

  const claims: ClaimReport[] = manifest.claims.map((claim) => {
    const classified = classifyClaim(claim.id, counterexamples);
    return {
      id: claim.id,
      description: claim.description,
      ...classified,
    };
  });

  return {
    name: manifest.name,
    goal: manifest.goal,
    assumptions: manifest.assumptions,
    gaps: manifest.gaps,
    outcome: classifyOutcome(control, counterexamples, claims),
    control,
    counterexamples,
    claims,
  };
}
