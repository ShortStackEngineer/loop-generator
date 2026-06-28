import type { LoopSpec } from "../core/spec";
import type { PreflightResult } from "../core/preflight";
import type { LintFinding, SpecLintContext } from "./types";
import { SPEC_RULES, PREFLIGHT_RULE_IDS } from "./rules";

/**
 * Spec-level linting only — no batch/runner dependency, so the engine can import
 * this for run-path preflight without creating an import cycle.
 */

/** Run every spec rule against a single spec + its resolved workdir. */
export function lintSpec(spec: LoopSpec, ctx: Omit<SpecLintContext, "spec">): LintFinding[] {
  const full: SpecLintContext = { spec, ...ctx };
  return SPEC_RULES.flatMap((rule) => rule.run(full));
}

/**
 * The subset of spec rules the engine runs at the start of every loop. Returns
 * a PreflightResult so it merges with driver/evaluator preflight: error-severity
 * findings block the run, warnings/info are surfaced.
 */
export function workspacePreflight(spec: LoopSpec, workdir: string): PreflightResult {
  const findings = lintSpec(spec, { workdir }).filter((f) => PREFLIGHT_RULE_IDS.has(f.ruleId));
  // Preflight rules are only error/warn severity (no info), so there are no notes.
  // Stryker disable next-line StringLiteral
  const fmt = (f: LintFinding): string => `[${f.ruleId}] ${f.message}${f.hint ? ` — ${f.hint}` : ""}`;
  const errors = findings.filter((f) => f.severity === "error").map(fmt);
  const warnings = findings.filter((f) => f.severity === "warn").map(fmt);
  return { ok: errors.length === 0, errors, warnings };
}
