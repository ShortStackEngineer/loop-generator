/**
 * Pure status rules for check-validation reports.
 *
 * These classify *supplied examples*, not universal correctness: a "caught"
 * counterexample means a mapped check rejected that fixture; a "validated"
 * claim means every supplied counterexample for it was caught.
 */

export type CheckRunStatus = "passed" | "rejected" | "error";
export type CounterexampleStatus = "caught" | "escaped" | "error";
export type ClaimStatus = "validated" | "gap" | "error";
export type CheckValidationOutcome = "validated" | "gaps" | "error";

export interface CheckRunResult {
  check: string;
  status: CheckRunStatus;
  exitCode: number | null;
  feedback: string;
}

export interface CounterexampleReport {
  id: string;
  claim: string;
  status: CounterexampleStatus;
  checks: CheckRunResult[];
}

export interface ClaimReport {
  id: string;
  description: string;
  status: ClaimStatus;
  /** Counterexample IDs rejected by a mapped check, with no execution errors. */
  caught?: string[];
  /** Counterexample IDs that no mapped check rejected. */
  escaped?: string[];
}

export interface CheckValidationReport {
  name: string;
  goal: string;
  assumptions: string[];
  /** Explicit free-form gaps from the manifest — never dropped on a validated report. */
  gaps: string[];
  outcome: CheckValidationOutcome;
  control: CheckRunResult[];
  counterexamples: CounterexampleReport[];
  claims: ClaimReport[];
}

export function classifyCheckExecution(args: {
  code: number | null;
  timedOut: boolean;
  aborted?: boolean;
  rejectExitCodes: readonly number[];
}): CheckRunStatus {
  if (args.aborted || args.timedOut) return "error";
  if (args.code === 0) return "passed";
  if (args.code !== null && args.rejectExitCodes.includes(args.code)) return "rejected";
  return "error";
}

export function controlPassed(control: readonly CheckRunResult[]): boolean {
  return control.length > 0 && control.every((r) => r.status === "passed");
}

/**
 * A counterexample is caught only if at least one check *mapped to its claim*
 * rejected it and no executed check errored. Errors never count as caught.
 */
export function classifyCounterexample(
  results: readonly CheckRunResult[],
  mappedCheckIds: readonly string[],
): CounterexampleStatus {
  if (results.some((r) => r.status === "error")) return "error";
  const mapped = new Set(mappedCheckIds);
  if (results.some((r) => r.status === "rejected" && mapped.has(r.check))) return "caught";
  return "escaped";
}

export function classifyClaim(
  claimId: string,
  counterexamples: readonly CounterexampleReport[],
): { status: ClaimStatus; caught?: string[]; escaped?: string[] } {
  const mapped = counterexamples.filter((ce) => ce.claim === claimId);
  if (mapped.length === 0) return { status: "gap" };

  const caught = mapped.filter((ce) => ce.status === "caught").map((ce) => ce.id);
  const escaped = mapped.filter((ce) => ce.status === "escaped").map((ce) => ce.id);
  const errored = mapped.some((ce) => ce.status === "error");

  const evidence = {
    ...(caught.length ? { caught } : {}),
    ...(escaped.length ? { escaped } : {}),
  };

  if (errored) return { status: "error", ...evidence };
  if (escaped.length) return { status: "gap", ...evidence };
  return { status: "validated", ...evidence };
}

/**
 * Execution errors (control failure, harness crash, abort, timeout) take
 * precedence over gaps. Control failure is always `error`.
 */
export function classifyOutcome(
  control: readonly CheckRunResult[],
  counterexamples: readonly CounterexampleReport[],
  claims: readonly ClaimReport[],
): CheckValidationOutcome {
  if (!controlPassed(control)) return "error";
  if (counterexamples.some((ce) => ce.status === "error")) return "error";
  if (claims.some((c) => c.status === "error")) return "error";
  if (claims.some((c) => c.status === "gap")) return "gaps";
  return "validated";
}

export function checkValidationExitCode(outcome: CheckValidationOutcome): 0 | 1 | 2 {
  if (outcome === "validated") return 0;
  if (outcome === "gaps") return 1;
  return 2;
}
