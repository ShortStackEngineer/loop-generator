import type { LoopSpec } from "../core/spec";

/** Lint severities, in increasing order of seriousness. */
export type LintSeverity = "info" | "warn" | "error";

export interface LintFinding {
  /** Stable rule id, e.g. "SPEC-WORKDIR-NOT-PROJECT". */
  ruleId: string;
  severity: LintSeverity;
  message: string;
  /** Dot-path into the spec/manifest the finding refers to (best-effort). */
  path?: string;
  /** Actionable suggestion. */
  hint?: string;
  /** For batch lint: which item the finding came from. */
  item?: string;
}

/** Context handed to a spec rule. `workdir` is already resolved to an absolute path. */
export interface SpecLintContext {
  spec: LoopSpec;
  workdir: string;
  /** Absolute path to the spec file, if it came from disk. */
  file?: string;
}

export interface SpecRule {
  id: string;
  severity: LintSeverity;
  /** Whether this rule also runs in the engine's run-path preflight. */
  preflight: boolean;
  run(ctx: SpecLintContext): LintFinding[];
}
