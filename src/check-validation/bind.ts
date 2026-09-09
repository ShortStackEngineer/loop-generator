import type { SpecEvaluator } from "../core/spec";
import type { ChecksManifest, CheckSpec } from "./manifest";

/**
 * Bind each manifest check to exactly one command evaluator.
 *
 * Matching is by effective alias (`as` ?? `uses`), exact `command`, and
 * effective `timeoutMs`. Command evaluators have no default timeout — the
 * spec must set an explicit timeout that equals the check's (including the
 * manifest default of 10000). Non-command evaluators can never satisfy a
 * binding. Incompatible evaluator options (non-root cwd, nonempty env,
 * expectExitCode other than 0, score constraints) are rejected before any
 * check command runs.
 */

export interface CheckBindingResult {
  /** Actionable errors; nonempty means do not run any check. */
  errors: string[];
  /** Evaluator aliases that were not bound to a manifest check. */
  unmapped: string[];
}

function effectiveAlias(evaluator: SpecEvaluator): string {
  return evaluator.as ?? evaluator.uses;
}

function isRootCwd(cwd: unknown): boolean {
  // Omitted is the command-evaluator default (run in the workspace root).
  // `null` is invalid for the schema — not default-equivalent.
  if (cwd === undefined) return true;
  if (typeof cwd !== "string") return false;
  return cwd === "" || cwd === "." || cwd === "./";
}

function isEmptyEnv(env: unknown): boolean {
  // Omitted / `{}` are default-equivalent (no extra env). `null` is invalid.
  if (env === undefined) return true;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
  return Object.keys(env as Record<string, unknown>).length === 0;
}

function isDefaultExitCode(code: unknown): boolean {
  // Omitted or explicit `0` match the command-evaluator default. `null` is invalid.
  return code === undefined || code === 0;
}

function optionIncompatibilities(check: CheckSpec, evaluator: SpecEvaluator): string[] {
  const opts = evaluator.options ?? {};
  const issues: string[] = [];
  const alias = effectiveAlias(evaluator);

  if (opts.command !== check.command) {
    issues.push(
      `check validation: check "${check.id}" command does not match evaluator "${alias}"`,
    );
  }

  if (typeof opts.timeoutMs !== "number" || !Number.isFinite(opts.timeoutMs)) {
    issues.push(
      `check validation: check "${check.id}" requires evaluator "${alias}" to set an explicit timeoutMs matching ${check.timeoutMs} (command evaluators have no default timeout)`,
    );
  } else if (opts.timeoutMs !== check.timeoutMs) {
    issues.push(
      `check validation: check "${check.id}" timeoutMs ${check.timeoutMs} does not match evaluator "${alias}" timeoutMs ${opts.timeoutMs}`,
    );
  }

  if (opts.cwd === null) {
    issues.push(
      `check validation: evaluator "${alias}" cwd is null which is invalid for the command evaluator schema (omit the field for the default); cannot bind to check "${check.id}"`,
    );
  } else if (!isRootCwd(opts.cwd)) {
    issues.push(
      `check validation: evaluator "${alias}" has a non-root cwd which cannot bind to check "${check.id}"`,
    );
  }
  if (opts.env === null) {
    issues.push(
      `check validation: evaluator "${alias}" env is null which is invalid for the command evaluator schema (omit the field for the default); cannot bind to check "${check.id}"`,
    );
  } else if (!isEmptyEnv(opts.env)) {
    issues.push(
      `check validation: evaluator "${alias}" has a nonempty env which cannot bind to check "${check.id}"`,
    );
  }
  if (opts.expectExitCode === null) {
    issues.push(
      `check validation: evaluator "${alias}" expectExitCode is null which is invalid for the command evaluator schema (omit the field or set 0); cannot bind to check "${check.id}"`,
    );
  } else if (!isDefaultExitCode(opts.expectExitCode)) {
    issues.push(
      `check validation: evaluator "${alias}" expectExitCode is not 0 which cannot bind to check "${check.id}"`,
    );
  }
  if (opts.scoreRegex !== undefined || opts.scoreGte !== undefined || opts.scoreLte !== undefined) {
    issues.push(
      `check validation: evaluator "${alias}" score constraints (scoreRegex/scoreGte/scoreLte) cannot bind to check "${check.id}"`,
    );
  }

  return issues;
}

/**
 * Validate that every manifest check binds to exactly one compatible command
 * evaluator, and list evaluator aliases that the manifest does not cover.
 */
export function bindManifestChecks(
  manifest: ChecksManifest,
  evaluators: readonly SpecEvaluator[],
): CheckBindingResult {
  const errors: string[] = [];
  const byAlias = new Map<string, SpecEvaluator[]>();
  for (const evaluator of evaluators) {
    const alias = effectiveAlias(evaluator);
    const list = byAlias.get(alias) ?? [];
    list.push(evaluator);
    byAlias.set(alias, list);
  }

  for (const [alias, list] of byAlias) {
    if (list.length > 1) {
      errors.push(`check validation: duplicate evaluator alias "${alias}"`);
    }
  }

  const bound = new Set<string>();
  for (const check of manifest.checks) {
    const matches = byAlias.get(check.id) ?? [];
    if (matches.length > 1) {
      // Duplicate alias already reported; still not a valid unique binding.
      continue;
    }
    const evaluator = matches[0];
    if (!evaluator) {
      errors.push(
        `check validation: check "${check.id}" is not bound to a command evaluator (need matching alias \`as\` or \`uses\`)`,
      );
      continue;
    }
    if (evaluator.uses !== "command") {
      errors.push(
        `check validation: check "${check.id}" matches non-command evaluator "${effectiveAlias(evaluator)}" (uses: ${evaluator.uses}); only command evaluators can satisfy manifest checks`,
      );
      continue;
    }
    const incompat = optionIncompatibilities(check, evaluator);
    if (incompat.length) {
      errors.push(...incompat);
      continue;
    }
    bound.add(check.id);
  }

  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const evaluator of evaluators) {
    const alias = effectiveAlias(evaluator);
    if (bound.has(alias) || seen.has(alias)) continue;
    seen.add(alias);
    unmapped.push(alias);
  }

  return { errors, unmapped };
}

export function unmappedEvaluatorsWarning(unmapped: readonly string[]): string {
  return `check validation did not cover evaluator(s): ${unmapped.join(", ")}`;
}
