import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { LoopSpec } from "./spec";

/**
 * Holdout evaluators — graders the agent never sees.
 *
 * A capable agentic driver reads the test files in the workspace and iterates
 * against them inside its own session, so the engine's feedback loop rarely
 * engages and the agent is effectively teaching to a visible test. A holdout
 * mapping keeps the grader OUTSIDE the workspace (next to the spec, typically)
 * and materializes it at a workspace path only while evaluators run; it is
 * removed again before the next agent turn. The agent's only signal is the
 * failure text carried back in feedback.
 *
 * Scope note: this hides the grader from an agent that stays inside its
 * workspace. An agent with unrestricted shell access can still read elsewhere
 * on disk — the same trust level as the spec file itself. The holdout source is
 * hash-watched under `limits.evaluatorGuard`, so editing it mid-run is flagged
 * (or fails the run) like any other evaluator tampering.
 */

export interface HoldoutMapping {
  /** Evaluator instance name the mapping belongs to (for messages). */
  evaluator: string;
  /** Absolute path of the grader source file (kept outside the workspace). */
  from: string;
  /** Workspace-relative path the file is materialized at during evaluation. */
  to: string;
}

export interface ResolvedHoldouts {
  mappings: HoldoutMapping[];
  /** Hard misconfigurations: missing source, a destination escaping the workspace. */
  errors: string[];
  /** Cautions surfaced on the run (e.g. a source that lives inside the workspace). */
  warnings: string[];
}

/** True if `abs` resolves inside `root` (not equal to it, no `..` escape). */
function within(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Validate and resolve every `evaluators[].holdout` entry. `from` resolves
 * against the spec's base directory (where the spec file lives), `to` against
 * the workspace. Errors here should fail the run before any agent spend — an
 * evaluator whose grader can't be materialized measures nothing.
 */
export function resolveHoldouts(spec: LoopSpec, baseDir: string, workdir: string): ResolvedHoldouts {
  const mappings: HoldoutMapping[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const ev of spec.evaluators) {
    const name = ev.as ?? ev.uses;
    for (const h of ev.holdout ?? []) {
      const from = path.resolve(baseDir, h.from);
      const toAbs = path.resolve(workdir, h.to);
      if (!within(workdir, toAbs)) {
        errors.push(`evaluator "${name}": holdout destination "${h.to}" escapes the workspace`);
        continue;
      }
      if (!existsSync(from) || !statSync(from).isFile()) {
        errors.push(`evaluator "${name}": holdout source "${h.from}" not found at ${from} (must be an existing file)`);
        continue;
      }
      if (within(workdir, from)) {
        warnings.push(
          `evaluator "${name}": holdout source "${h.from}" resolves inside the workspace — the agent can read it, which defeats the holdout; keep grader sources next to the spec instead`,
        );
      }
      mappings.push({ evaluator: name, from, to: h.to.replace(/\\/g, "/") });
    }
  }
  return { mappings, errors, warnings };
}

export interface MaterializedHoldouts {
  /**
   * Remove the materialized graders and put back anything they displaced.
   * Returns caveat messages (a pre-existing file at a destination was
   * temporarily displaced during evaluation).
   */
  restore(): string[];
}

/** Suffix for the backup a displaced destination file is parked at. */
const BACKUP_SUFFIX = ".loopgen-holdout-displaced";

/**
 * Copy every holdout grader into the workspace. If a file already exists at a
 * destination (a stub, or something the agent wrote there), it is parked at a
 * backup path and put back on restore — the grader that runs is always the
 * spec author's copy. Throws when a copy fails; running the evaluators without
 * their graders would measure nothing.
 */
export function materializeHoldouts(mappings: HoldoutMapping[], workdir: string): MaterializedHoldouts {
  const placed: string[] = [];
  const displaced: { at: string; backup: string }[] = [];
  const restore = (): string[] => {
    for (const abs of placed) rmSync(abs, { force: true });
    const notes: string[] = [];
    for (const d of displaced) {
      try {
        renameSync(d.backup, d.at);
      } catch {
        notes.push(`could not restore the file displaced from ${d.at} (backup left at ${d.backup})`);
      }
    }
    return notes;
  };
  try {
    for (const m of mappings) {
      const toAbs = path.resolve(workdir, m.to);
      if (existsSync(toAbs)) {
        const backup = toAbs + BACKUP_SUFFIX;
        renameSync(toAbs, backup);
        displaced.push({ at: toAbs, backup });
      }
      mkdirSync(path.dirname(toAbs), { recursive: true });
      copyFileSync(m.from, toAbs);
      placed.push(toAbs);
    }
  } catch (err) {
    restore();
    throw new Error(`could not materialize holdout grader(s): ${(err as Error).message}`);
  }
  const displacedNotes = displaced.map(
    (d) => `a file already existed at holdout destination ${path.relative(workdir, d.at)} — it was temporarily displaced while evaluators ran`,
  );
  return {
    restore: () => [...displacedNotes, ...restore()],
  };
}
