import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import type { LoopSpec } from "./spec";

/**
 * Evaluator-integrity guard — resolve the test files a spec's `command`
 * evaluators depend on, so the engine can watch them the way `specGuard` watches
 * the `.loop.yaml`. The success criteria for a `command` check live in the test
 * files it runs; if the agent edits those, a green result can't be trusted.
 *
 * Two sources, both scoped to the workspace:
 *   1. Auto-detected — test-like files NAMED in an evaluator's command (e.g.
 *      `bin/rails test test/integration/foo_test.rb`). A bare runner with no
 *      file arguments (`npm test`) names nothing and is intentionally not
 *      watched — that's the whole-suite case.
 *   2. Explicit — `evaluators[].guard: [...]` paths (a file, or a directory whose
 *      test-like files are watched recursively) for non-obvious cases.
 */

/** `foo_test.rb`, `foo.test.ts`, `foo-spec.js`, `foo_spec.rb`, … */
const TEST_FILE_SUFFIX = /[._-](?:test|spec)\.[A-Za-z0-9]+$/;
/** A path that lives under a conventional test/spec directory. */
const TEST_DIR = /(?:^|\/)(?:tests?|specs?|__tests__)\//;

/** Heuristic: does this workspace-relative path look like a test/spec file? */
export function isTestLikePath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return TEST_FILE_SUFFIX.test(p) || TEST_DIR.test(p);
}

/** Split a shell command into tokens, honoring simple single/double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens;
}

/** Normalize a token/path to a clean workspace-relative path, or null if unusable. */
function toRel(token: string): string | null {
  const t = token.trim().replace(/^\.\//, "");
  if (!t || t.startsWith("-") || path.isAbsolute(t)) return null;
  return t.replace(/\\/g, "/");
}

/** True if `abs` resolves to something inside `workdir` (no `..` escape). */
function within(workdir: string, abs: string): boolean {
  const rel = path.relative(workdir, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "tmp",
  "log",
  "coverage",
  ".loopgen",
  "vendor",
  "dist",
]);

/**
 * Recursively collect workspace-relative files under an explicitly-guarded
 * directory (bounded). All files are watched — the user opted in by listing the
 * directory in `guard` — except contents of well-known build/vcs dirs.
 */
function walkDir(dir: string, workdir: string, out: Set<string>, budget: { n: number }): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n <= 0) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkDir(abs, workdir, out, budget);
    } else if (e.isFile()) {
      out.add(path.relative(workdir, abs).replace(/\\/g, "/"));
      budget.n--;
    }
  }
}

/** Add an explicit `guard` entry (a file or a directory) to the watch set. */
function addGuardEntry(set: Set<string>, workdir: string, entry: string, budget: { n: number }): void {
  const rel = toRel(entry);
  if (!rel) return;
  const abs = path.resolve(workdir, rel);
  if (!within(workdir, abs) || !existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isFile()) set.add(rel);
  else if (st.isDirectory()) walkDir(abs, workdir, set, budget);
}

/**
 * Resolve the set of workspace-relative files the spec's evaluators depend on and
 * that should be guarded. Only existing files are returned (a file that doesn't
 * exist yet can't be watched). Result is sorted for stable ordering.
 */
export function resolveGuardedFiles(spec: LoopSpec, workdir: string): string[] {
  const set = new Set<string>();
  const budget = { n: 5000 }; // cap recursive directory scans
  for (const ev of spec.evaluators) {
    for (const entry of ev.guard ?? []) addGuardEntry(set, workdir, entry, budget);

    const command = ev.options?.command;
    if (typeof command !== "string") continue;
    for (const token of tokenize(command)) {
      const rel = toRel(token);
      if (!rel) continue;
      const abs = path.resolve(workdir, rel);
      if (within(workdir, abs) && isTestLikePath(rel) && existsSync(abs) && statSync(abs).isFile()) {
        set.add(rel);
      }
    }
  }
  return [...set].sort();
}
