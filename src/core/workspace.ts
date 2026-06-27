import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Git-backed change detection for the workspace. The engine uses this to answer
 * a question the agent itself can't be trusted to answer honestly: "did this
 * iteration actually change anything?" A green run that changed nothing is the
 * signature of vacuous success (checks that don't exercise the requirement).
 *
 * Everything here is non-destructive: snapshots use a throwaway index file via
 * GIT_INDEX_FILE, so the user's real staging area and working tree are never
 * touched. Ignored files (.gitignore) are excluded, which is what we want.
 */

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(dir: string, args: string[], extraEnv?: Record<string, string>): GitResult {
  const res = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/**
 * True if `dir` itself is git-ignored. When the workspace is ignored (e.g. a
 * build/output dir), `git add -A` skips its contents, so tree snapshots can't
 * see changes — change detection must fall back to driver-reported files.
 */
export function isIgnored(dir: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "."], { cwd: dir }).status === 0;
}

/** Change detection is usable only in a git repo whose workspace isn't ignored. */
export function changeDetectionAvailable(dir: string): boolean {
  return isGitRepo(dir) && !isIgnored(dir);
}

/**
 * Capture a content hash of the entire (non-ignored) working tree as a git tree
 * object. Two snapshots that hash equal mean the working tree is byte-identical.
 * Returns null if anything goes wrong (caller falls back to driver-reported data).
 */
export function snapshotTree(dir: string): string | null {
  const idxDir = mkdtempSync(path.join(tmpdir(), "loopgen-idx-"));
  const idxFile = path.join(idxDir, "index");
  try {
    // Empty temp index + `add -A` => index mirrors the full working tree.
    if (!git(dir, ["add", "-A"], { GIT_INDEX_FILE: idxFile }).ok) return null;
    const tree = git(dir, ["write-tree"], { GIT_INDEX_FILE: idxFile });
    return tree.ok ? tree.stdout.trim() : null;
  } finally {
    rmSync(idxDir, { recursive: true, force: true });
  }
}

/**
 * Built-in artifact patterns excluded from change detection. These are written
 * as a side effect of running the app/tests (logs, databases, compile caches,
 * generated assets) and must not count as "the agent did work" — otherwise an
 * agent that merely runs the test suite defeats the no-op guard. Matched as git
 * pathspecs (where `*` also crosses `/`).
 */
export const DEFAULT_IGNORE_GLOBS: string[] = [
  "log",
  "tmp",
  "node_modules",
  "coverage",
  ".loopgen",
  "*.log",
  "*.sqlite3",
  "*.sqlite3-shm",
  "*.sqlite3-wal",
  "app/assets/builds",
  "public/assets",
  "public/packs",
];

export interface TreeDiff {
  changed: boolean;
  files: string[];
  /** `git diff --stat` text, empty when nothing meaningful changed. */
  stat: string;
}

/** Build the pathspec for a diff: limit to cwd, minus the ignore globs. */
function diffPathspec(ignore: string[]): string[] {
  return [".", ...ignore.map((p) => `:(exclude)${p}`)];
}

/**
 * Diff two tree snapshots, ignoring artifact noise. `changed` reflects only
 * meaningful (non-ignored) files, so runtime churn (logs/db/cache) can neither
 * mask a no-op nor inflate the reported diff.
 */
export function diffTrees(
  dir: string,
  before: string | null,
  after: string | null,
  ignore: string[] = DEFAULT_IGNORE_GLOBS,
): TreeDiff {
  if (!before || !after || before === after) return { changed: false, files: [], stat: "" };

  const pathspec = diffPathspec(ignore);
  const files = git(dir, ["diff", "--name-only", before, after, "--", ...pathspec])
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // Only pay for --stat when something meaningful changed.
  const stat = files.length ? git(dir, ["diff", "--stat", before, after, "--", ...pathspec]).stdout.trim() : "";
  return { changed: files.length > 0, files, stat };
}
