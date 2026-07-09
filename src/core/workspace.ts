import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Change detection for the workspace. The engine uses this to answer a question
 * the agent itself can't be trusted to answer honestly: "did this iteration
 * actually change anything?" A green run that changed nothing is the signature
 * of vacuous success (checks that don't exercise the requirement).
 *
 * Prefer git when available (throwaway index via GIT_INDEX_FILE — non-destructive).
 * When the workspace is not a git repo (or is git-ignored), fall back to a
 * content-hash walk of the working tree so real edits still count even if the
 * driver omits `changedFiles`.
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

/** Default hard cap on the patch fed back to the agent — keeps prompts bounded. */
export const DEFAULT_MAX_PATCH_CHARS = 8000;

// ---------------------------------------------------------------------------
// Content-hash fallback (non-git workspaces)
// ---------------------------------------------------------------------------

/**
 * Directories skipped by the content-hash walker. Mirrors the build/vcs noise
 * git-ignore usually hides, plus common framework output dirs.
 */
const CONTENT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "tmp",
  "log",
  "coverage",
  ".loopgen",
  "vendor",
  "dist",
  ".next",
  "build",
  ".turbo",
  ".cache",
]);

/** Hard cap on files hashed per snapshot — keeps large monorepos bounded. */
export const CONTENT_SNAPSHOT_FILE_CAP = 5000;

/**
 * Map of workspace-relative paths → sha256 of file contents. Used when git
 * change detection is unavailable.
 */
export type ContentSnapshot = Map<string, string>;

function matchesIgnoreGlob(rel: string, glob: string): boolean {
  // Support the small subset of git pathspecs we ship in DEFAULT_IGNORE_GLOBS:
  // exact path prefixes, `*` / `**` wildcards, and simple `*.ext` suffix globs.
  const norm = rel.replace(/\\/g, "/");
  const g = glob.replace(/\\/g, "/");
  if (g.startsWith("*.") && !g.includes("/", 1)) {
    return norm.endsWith(g.slice(1)) || norm.includes(`/${g.slice(1)}`);
  }
  // Escape regex specials except * which becomes "match any chars including /".
  const re = new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*")}$`,
  );
  if (re.test(norm)) return true;
  // Directory-style ignore: "log" matches "log" and "log/foo".
  if (!g.includes("*") && (norm === g || norm.startsWith(`${g}/`))) return true;
  return false;
}

function isContentIgnored(rel: string, ignore: string[]): boolean {
  const base = path.posix.basename(rel.replace(/\\/g, "/"));
  if (CONTENT_SKIP_DIRS.has(base)) return true;
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (CONTENT_SKIP_DIRS.has(part)) return true;
  }
  for (const g of ignore) {
    if (matchesIgnoreGlob(rel, g)) return true;
  }
  return false;
}

function hashFileContents(abs: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function walkContent(
  dir: string,
  workdir: string,
  ignore: string[],
  out: ContentSnapshot,
  budget: { n: number },
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n <= 0) return;
    if (CONTENT_SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(workdir, abs).replace(/\\/g, "/");
    if (isContentIgnored(rel, ignore)) continue;
    if (e.isDirectory()) {
      walkContent(abs, workdir, ignore, out, budget);
    } else if (e.isFile()) {
      const hash = hashFileContents(abs);
      if (hash) {
        out.set(rel, hash);
        budget.n--;
      }
    }
  }
}

/**
 * Hash every non-ignored file under `dir`. Returns an empty map when the
 * directory is missing. Bounded by {@link CONTENT_SNAPSHOT_FILE_CAP}.
 */
export function snapshotContent(
  dir: string,
  ignore: string[] = DEFAULT_IGNORE_GLOBS,
): ContentSnapshot {
  const out: ContentSnapshot = new Map();
  if (!existsSync(dir)) return out;
  try {
    if (!statSync(dir).isDirectory()) return out;
  } catch {
    return out;
  }
  walkContent(dir, dir, ignore, out, { n: CONTENT_SNAPSHOT_FILE_CAP });
  return out;
}

/**
 * Diff two content snapshots into the same shape as {@link diffTrees}. `stat`
 * is a short human summary (no unified diff — hashing has no line-level info).
 */
export function diffContent(before: ContentSnapshot, after: ContentSnapshot): TreeDiff {
  const files: string[] = [];
  for (const [rel, hash] of after) {
    if (before.get(rel) !== hash) files.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) files.push(rel);
  }
  files.sort();
  if (files.length === 0) return { changed: false, files: [], stat: "" };
  const listed = files.slice(0, 20).join(", ");
  const more = files.length > 20 ? ` (+${files.length - 20} more)` : "";
  return {
    changed: true,
    files,
    stat: `${files.length} file(s) changed (content-hash): ${listed}${more}`,
  };
}

/**
 * Produce a bounded unified-diff patch between two tree snapshots, respecting
 * the same ignore globs as change detection. Feeds the agent "here's what you
 * changed last turn" so it stops re-deriving state it already touched.
 *
 * Returns null when there's nothing useful to show (missing snapshots,
 * identical trees, git failure, or an empty diff). Caps output at `maxChars`:
 * an over-cap patch is truncated to its head with a marker rather than dropped,
 * so a huge diff degrades gracefully instead of blowing up the prompt.
 */
export function diffPatch(
  dir: string,
  before: string | null,
  after: string | null,
  ignore: string[] = DEFAULT_IGNORE_GLOBS,
  maxChars: number = DEFAULT_MAX_PATCH_CHARS,
): string | null {
  if (!before || !after || before === after) return null;
  const res = git(dir, ["diff", before, after, "--", ...diffPathspec(ignore)]);
  if (!res.ok) return null;
  const patch = res.stdout.trim();
  if (!patch) return null;
  if (patch.length <= maxChars) return patch;
  const omitted = patch.length - maxChars;
  return `${patch.slice(0, maxChars)}\n…[patch truncated: ${omitted} more char(s) omitted; inspect the workspace for the full diff]…`;
}
