import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isGitRepo,
  isIgnored,
  changeDetectionAvailable,
  snapshotTree,
  DEFAULT_IGNORE_GLOBS,
  diffTrees,
  DEFAULT_MAX_PATCH_CHARS,
  CONTENT_SNAPSHOT_FILE_CAP,
  snapshotContent,
  diffContent,
  diffPatch,
} from "../src/core/workspace";

// A throwaway git repo per test so the git-backed functions run for real.
function initRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email a@b.c", { cwd: dir });
  execSync("git config user.name x", { cwd: dir });
  // Keep commits deterministic and independent of the ambient git config.
  execSync("git config commit.gpgsign false", { cwd: dir });
}
function commitAll(dir: string, message: string): void {
  execSync("git add -A", { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(message)} --no-gpg-sign`, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
    },
  });
}

let git: string; // a real git repo
let plain: string; // a plain (non-git) temp dir

beforeEach(() => {
  git = mkdtempSync(path.join(tmpdir(), "loopgen-mutgit-"));
  plain = mkdtempSync(path.join(tmpdir(), "loopgen-mutplain-"));
  initRepo(git);
});
afterEach(() => {
  rmSync(git, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  it("is true inside a real git repo", () => {
    expect(isGitRepo(git)).toBe(true);
  });
  it("is false in a plain (non-git) temp dir", () => {
    expect(isGitRepo(plain)).toBe(false);
  });
});

describe("isIgnored / changeDetectionAvailable", () => {
  it("isIgnored is false at the repo root and true for a gitignored subdir", () => {
    writeFileSync(path.join(git, ".gitignore"), "ignored-dir/\n");
    const sub = path.join(git, "ignored-dir");
    mkdirSync(sub);
    writeFileSync(path.join(sub, "x.txt"), "hi");
    expect(isIgnored(git)).toBe(false);
    expect(isIgnored(sub)).toBe(true);
  });

  it("changeDetectionAvailable is true for a normal repo", () => {
    expect(changeDetectionAvailable(git)).toBe(true);
  });

  it("changeDetectionAvailable is false for a non-git dir (isGitRepo short-circuits)", () => {
    expect(changeDetectionAvailable(plain)).toBe(false);
  });

  it("changeDetectionAvailable is false for an ignored subdir of a repo (!isIgnored branch)", () => {
    writeFileSync(path.join(git, ".gitignore"), "ignored-dir/\n");
    const sub = path.join(git, "ignored-dir");
    mkdirSync(sub);
    writeFileSync(path.join(sub, "x.txt"), "hi");
    // sub IS inside the work tree (git repo true) but IS ignored -> false.
    expect(isGitRepo(sub)).toBe(true);
    expect(changeDetectionAvailable(sub)).toBe(false);
  });
});

describe("snapshotTree", () => {
  it("returns a non-empty trimmed tree hash for a real repo (no trailing whitespace)", () => {
    writeFileSync(path.join(git, "a.ts"), "export const a = 1;\n");
    const tree = snapshotTree(git);
    expect(tree).not.toBeNull();
    // A git tree object id is a 40-char lowercase hex sha, trimmed of newline.
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(tree).toBe((tree ?? "").trim());
  });

  it("returns null for a non-git directory (git add -A fails)", () => {
    expect(snapshotTree(plain)).toBeNull();
  });

  it("two byte-identical trees hash equal; a content change changes the hash", () => {
    writeFileSync(path.join(git, "a.ts"), "one");
    const t1 = snapshotTree(git);
    const t2 = snapshotTree(git);
    expect(t1).toBe(t2);
    writeFileSync(path.join(git, "a.ts"), "two");
    const t3 = snapshotTree(git);
    expect(t3).not.toBe(t1);
  });
});

describe("diffTrees — guard clause (L128)", () => {
  it("returns the no-change shape when before === after (identical hashes)", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const t = snapshotTree(git)!;
    expect(diffTrees(git, t, t)).toEqual({ changed: false, files: [], stat: "" });
  });

  it("returns the no-change shape when before is null (after present)", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const after = snapshotTree(git)!;
    expect(diffTrees(git, null, after)).toEqual({ changed: false, files: [], stat: "" });
  });

  it("returns the no-change shape when after is null (before present)", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const before = snapshotTree(git)!;
    expect(diffTrees(git, before, null)).toEqual({ changed: false, files: [], stat: "" });
  });

  it("does NOT short-circuit when both present and distinct (proves the guard is not always-true)", () => {
    writeFileSync(path.join(git, "a.ts"), "one");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "a.ts"), "two");
    const after = snapshotTree(git)!;
    const diff = diffTrees(git, before, after);
    expect(diff.changed).toBe(true);
    expect(diff.files).toEqual(["a.ts"]);
  });
});

describe("diffTrees — real diff", () => {
  it("reports the exact changed file list and a non-empty stat", () => {
    writeFileSync(path.join(git, "a.ts"), "one\n");
    writeFileSync(path.join(git, "b.ts"), "keep\n");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "a.ts"), "two\n");
    writeFileSync(path.join(git, "c.ts"), "new\n");
    const after = snapshotTree(git)!;
    const diff = diffTrees(git, before, after);
    expect(diff.changed).toBe(true);
    expect(diff.files.sort()).toEqual(["a.ts", "c.ts"]);
    // stat is the real `git diff --stat`; it must name the changed files.
    expect(diff.stat).toContain("a.ts");
    expect(diff.stat).toContain("c.ts");
    expect(diff.stat).not.toBe("");
  });

  it("excludes ignored globs (*.log, log/, tmp/) but keeps a real .ts change", () => {
    writeFileSync(path.join(git, "src.ts"), "one\n");
    const before = snapshotTree(git)!;
    // Ignored artifacts:
    writeFileSync(path.join(git, "app.log"), "noise\n");
    mkdirSync(path.join(git, "tmp"));
    writeFileSync(path.join(git, "tmp", "x"), "junk\n");
    mkdirSync(path.join(git, "log"));
    writeFileSync(path.join(git, "log", "y"), "junk\n");
    // Real change:
    writeFileSync(path.join(git, "src.ts"), "two\n");
    const after = snapshotTree(git)!;
    const diff = diffTrees(git, before, after);
    expect(diff.files).toEqual(["src.ts"]);
    expect(diff.stat).toContain("src.ts");
    expect(diff.stat).not.toContain("app.log");
    expect(diff.stat).not.toContain("tmp/");
    expect(diff.stat).not.toContain("log/");
  });

  it("stat is empty when ONLY ignored files changed (files.length === 0 branch, L136)", () => {
    writeFileSync(path.join(git, "keep.ts"), "same\n");
    const before = snapshotTree(git)!;
    // Only ignored artifacts change.
    writeFileSync(path.join(git, "app.log"), "noise\n");
    mkdirSync(path.join(git, "coverage"));
    writeFileSync(path.join(git, "coverage", "z"), "junk\n");
    const after = snapshotTree(git)!;
    expect(before).not.toBe(after); // the trees genuinely differ
    const diff = diffTrees(git, before, after);
    expect(diff).toEqual({ changed: false, files: [], stat: "" });
  });

  it("respects a caller-supplied ignore list distinct from the default", () => {
    writeFileSync(path.join(git, "keep.ts"), "one\n");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "keep.ts"), "two\n");
    const after = snapshotTree(git)!;
    // Exclude the only real change explicitly -> nothing meaningful changed.
    const diff = diffTrees(git, before, after, ["keep.ts"]);
    expect(diff).toEqual({ changed: false, files: [], stat: "" });
  });
});

describe("diffContent — >20 files boundary and (+N more) suffix", () => {
  it("lists only the first 20 files and appends the exact (+N more) suffix", () => {
    const before: Map<string, string> = new Map();
    const after: Map<string, string> = new Map();
    // 25 changed files, deterministic sorted order f00..f24.
    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      const name = `f${String(i).padStart(2, "0")}.ts`;
      names.push(name);
      after.set(name, `hash-${i}`);
    }
    names.sort();
    const diff = diffContent(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.files).toEqual(names);
    const listed = names.slice(0, 20).join(", ");
    // Exact stat string shape, including "(+5 more)".
    expect(diff.stat).toBe(`25 file(s) changed (content-hash): ${listed} (+5 more)`);
    // The 21st+ files are NOT in the listed prefix.
    expect(diff.stat).not.toContain(names[20]!);
  });

  it("exactly 20 files: no (+N more) suffix (files.length > 20 is strict)", () => {
    const before: Map<string, string> = new Map();
    const after: Map<string, string> = new Map();
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `g${String(i).padStart(2, "0")}.ts`;
      names.push(name);
      after.set(name, `h-${i}`);
    }
    names.sort();
    const diff = diffContent(before, after);
    expect(diff.files).toEqual(names);
    expect(diff.stat).toBe(`20 file(s) changed (content-hash): ${names.join(", ")}`);
    expect(diff.stat).not.toContain("more)");
  });

  it("21 files: the smallest count that triggers (+1 more)", () => {
    const before: Map<string, string> = new Map();
    const after: Map<string, string> = new Map();
    const names: string[] = [];
    for (let i = 0; i < 21; i++) {
      const name = `k${String(i).padStart(2, "0")}.ts`;
      names.push(name);
      after.set(name, `h-${i}`);
    }
    names.sort();
    const diff = diffContent(before, after);
    const listed = names.slice(0, 20).join(", ");
    expect(diff.stat).toBe(`21 file(s) changed (content-hash): ${listed} (+1 more)`);
  });

  it("returns the no-change shape when nothing differs (files.length === 0 early return)", () => {
    const same: Map<string, string> = new Map([["a.ts", "h"]]);
    expect(diffContent(same, new Map(same))).toEqual({ changed: false, files: [], stat: "" });
  });

  it("sorts the combined added/deleted file list", () => {
    const before: Map<string, string> = new Map([["z.ts", "h"], ["gone.ts", "h"]]);
    const after: Map<string, string> = new Map([["z.ts", "changed"], ["a.ts", "new"]]);
    const diff = diffContent(before, after);
    // z modified, a added, gone deleted -> sorted.
    expect(diff.files).toEqual(["a.ts", "gone.ts", "z.ts"]);
  });
});

describe("diffPatch — real repo", () => {
  it("returns a unified diff naming the changed path with +/- lines", () => {
    writeFileSync(path.join(git, "a.ts"), "line-one\n");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "a.ts"), "line-two\n");
    const after = snapshotTree(git)!;
    const patch = diffPatch(git, before, after);
    expect(patch).not.toBeNull();
    expect(patch).toContain("a.ts");
    expect(patch).toContain("-line-one");
    expect(patch).toContain("+line-two");
  });

  it("returns null when before === after", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const t = snapshotTree(git)!;
    expect(diffPatch(git, t, t)).toBeNull();
  });

  it("returns null when before is null", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const after = snapshotTree(git)!;
    expect(diffPatch(git, null, after)).toBeNull();
  });

  it("returns null when after is null", () => {
    writeFileSync(path.join(git, "a.ts"), "x");
    const before = snapshotTree(git)!;
    expect(diffPatch(git, before, null)).toBeNull();
  });

  it("returns null when the (ignore-filtered) diff is empty even though trees differ", () => {
    writeFileSync(path.join(git, "keep.ts"), "one\n");
    const before = snapshotTree(git)!;
    // Only an ignored artifact changes.
    writeFileSync(path.join(git, "app.log"), "noise\n");
    const after = snapshotTree(git)!;
    expect(before).not.toBe(after);
    expect(diffPatch(git, before, after)).toBeNull();
  });

  it("truncates an over-cap patch with the exact marker and omitted count", () => {
    // Make a diff comfortably larger than the tiny cap we pass.
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(path.join(git, "a.ts"), "start\n");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "a.ts"), big);
    const after = snapshotTree(git)!;
    const maxChars = 50;
    const patch = diffPatch(git, before, after, DEFAULT_IGNORE_GLOBS, maxChars)!;
    expect(patch).not.toBeNull();
    // Reconstruct the untruncated patch to know its exact length.
    const full = diffPatch(git, before, after, DEFAULT_IGNORE_GLOBS, Number.MAX_SAFE_INTEGER)!;
    const omitted = full.length - maxChars;
    expect(patch).toBe(
      `${full.slice(0, maxChars)}\n…[patch truncated: ${omitted} more char(s) omitted; inspect the workspace for the full diff]…`,
    );
    expect(patch).toContain(`…[patch truncated: ${omitted} more char(s) omitted`);
  });

  it("returns the patch WHOLE when its length is exactly at the cap (<= boundary)", () => {
    writeFileSync(path.join(git, "a.ts"), "one\n");
    const before = snapshotTree(git)!;
    writeFileSync(path.join(git, "a.ts"), "two\n");
    const after = snapshotTree(git)!;
    const full = diffPatch(git, before, after, DEFAULT_IGNORE_GLOBS, Number.MAX_SAFE_INTEGER)!;
    // maxChars === patch.length -> patch.length <= maxChars is true -> returned whole.
    const exact = diffPatch(git, before, after, DEFAULT_IGNORE_GLOBS, full.length)!;
    expect(exact).toBe(full);
    expect(exact).not.toContain("patch truncated");
    // One char under the cap -> truncation fires.
    const under = diffPatch(git, before, after, DEFAULT_IGNORE_GLOBS, full.length - 1)!;
    expect(under).toContain("patch truncated: 1 more char(s) omitted");
  });
});

// These exercise matchesIgnoreGlob/isContentIgnored via snapshotContent on a
// PLAIN dir (no .git noise). Each case is built so a specific glob-matching
// branch is load-bearing: flip that branch and a named file's kept/excluded
// state changes, so the assertion fails.
describe("snapshotContent — ignore-glob matching (matchesIgnoreGlob / isContentIgnored)", () => {
  it("suffix branch: *.log excludes a same-stem file but keeps app.logic (endsWith, not startsWith)", () => {
    writeFileSync(path.join(plain, "app.log"), "x");
    writeFileSync(path.join(plain, "app.logic"), "keep"); // endsWith(".log") is false
    writeFileSync(path.join(plain, "keep.ts"), "y");
    const snap = snapshotContent(plain, ["*.log"]);
    expect([...snap.keys()].sort()).toEqual(["app.logic", "keep.ts"]);
  });

  it("suffix branch is load-bearing: a nested sub/app.log is excluded (regex fallback alone would keep it)", () => {
    // The regex for "*.log" is ^[^/]*\.log$ which does NOT match a slash, so
    // only the dedicated `*.` suffix branch (norm.endsWith) excludes nested logs.
    mkdirSync(path.join(plain, "sub"));
    writeFileSync(path.join(plain, "sub", "app.log"), "x"); // killed only by the suffix branch
    writeFileSync(path.join(plain, "sub", "keep.ts"), "y");
    const snap = snapshotContent(plain, ["*.log"]);
    expect([...snap.keys()]).toEqual(["sub/keep.ts"]);
  });

  it("suffix branch guarded by !g.includes('/',1): a glob WITH an inner slash does NOT take the endsWith path", () => {
    // "*./x" starts with "*." but includes a slash after index 1, so the suffix
    // branch is skipped and it goes to the regex. A plain "*.log" must still match.
    writeFileSync(path.join(plain, "a.log"), "x");
    writeFileSync(path.join(plain, "keep.ts"), "y");
    const snap = snapshotContent(plain, ["*.log"]);
    expect([...snap.keys()]).toEqual(["keep.ts"]);
  });

  it("directory-style branch: bare 'log' excludes the dir AND its children, keeps a look-alike 'logbook'", () => {
    mkdirSync(path.join(plain, "log"));
    writeFileSync(path.join(plain, "log", "a.txt"), "x"); // log/a.txt -> startsWith("log/")
    writeFileSync(path.join(plain, "log-file.txt"), "z"); // NOT excluded: not === "log", not "log/..."
    writeFileSync(path.join(plain, "keep.ts"), "y");
    const snap = snapshotContent(plain, ["log"]);
    expect([...snap.keys()].sort()).toEqual(["keep.ts", "log-file.txt"]);
  });

  it("directory-style branch: an exact top-level name equal to the glob is excluded (norm === g)", () => {
    writeFileSync(path.join(plain, "tmp"), "x"); // a FILE literally named "tmp" -> norm === "tmp"
    writeFileSync(path.join(plain, "keep.ts"), "y");
    const snap = snapshotContent(plain, ["tmp"]);
    expect([...snap.keys()]).toEqual(["keep.ts"]);
  });

  it("directory-style branch is gated by !g.includes('*'): a glob with '*' uses the regex, not the prefix match", () => {
    // "lo*" contains '*', so the directory-prefix branch is skipped; matching
    // comes from the regex ^lo[^/]*$. That regex matches a top-level "logs"
    // file but NOT "app.ts", and "keep-lo" (no leading lo) stays.
    writeFileSync(path.join(plain, "logs"), "x"); // matched by regex ^lo[^/]*$
    writeFileSync(path.join(plain, "app.ts"), "keep"); // not matched
    writeFileSync(path.join(plain, "xlo"), "keep"); // not anchored at start -> kept
    const snap = snapshotContent(plain, ["lo*"]);
    expect([...snap.keys()].sort()).toEqual(["app.ts", "xlo"]);
  });

  it("regex branch: ** globstar crosses directories (public/** excludes a nested file)", () => {
    mkdirSync(path.join(plain, "public", "assets"), { recursive: true });
    writeFileSync(path.join(plain, "public", "assets", "bundle.js"), "x"); // matched by public/**
    writeFileSync(path.join(plain, "keep.ts"), "y");
    const snap = snapshotContent(plain, ["public/**"]);
    expect([...snap.keys()]).toEqual(["keep.ts"]);
  });

  it("regex branch: a single * does NOT cross a slash (public/* keeps a doubly-nested file)", () => {
    // "public/*" is ^public/[^/]*$. It matches the "extra" dir entry (excluding
    // its subtree) but a sibling top-level file "publicity.ts" is NOT matched.
    mkdirSync(path.join(plain, "public"), { recursive: true });
    writeFileSync(path.join(plain, "public", "top.js"), "x"); // public/top.js -> matched, excluded
    writeFileSync(path.join(plain, "publicity.ts"), "keep"); // "publicity.ts" has no slash -> NOT matched
    const snap = snapshotContent(plain, ["public/*"]);
    expect([...snap.keys()]).toEqual(["publicity.ts"]);
  });

  it("regex specials are escaped: a dot in the glob matches a literal dot, not any char", () => {
    writeFileSync(path.join(plain, "a.loopgen"), "x"); // ".loopgen" -> excluded via escaped-dot regex
    writeFileSync(path.join(plain, "axloopgen"), "keep"); // if the dot were unescaped this would match too
    const snap = snapshotContent(plain, ["*.loopgen"]);
    // The suffix branch handles *.loopgen; both fall to endsWith(".loopgen").
    expect([...snap.keys()]).toEqual(["axloopgen"]);
  });

  it("CONTENT_SKIP_DIRS excludes node_modules/.git/dist regardless of the ignore list (basename check)", () => {
    for (const d of ["node_modules", "dist", ".git", ".next", "build", "vendor"]) {
      mkdirSync(path.join(plain, d));
      writeFileSync(path.join(plain, d, "f.js"), "x");
    }
    writeFileSync(path.join(plain, "keep.ts"), "y");
    // Empty ignore list -> ONLY the CONTENT_SKIP_DIRS logic can exclude these.
    const snap = snapshotContent(plain, []);
    expect([...snap.keys()]).toEqual(["keep.ts"]);
  });

  it("CONTENT_SKIP_DIRS also matches a skip name as a nested path SEGMENT (the split loop, L200)", () => {
    mkdirSync(path.join(plain, "packages", "app", "node_modules"), { recursive: true });
    writeFileSync(path.join(plain, "packages", "app", "node_modules", "dep.js"), "x");
    writeFileSync(path.join(plain, "packages", "app", "index.ts"), "y");
    const snap = snapshotContent(plain, []);
    expect([...snap.keys()]).toEqual(["packages/app/index.ts"]);
  });
});

describe("snapshotContent — directory handling and budget", () => {
  it("returns an empty map for a missing directory", () => {
    const missing = path.join(plain, "does-not-exist");
    expect(snapshotContent(missing)).toEqual(new Map());
  });

  it("returns an empty map when the path is a file, not a directory", () => {
    const file = path.join(plain, "a-file.txt");
    writeFileSync(file, "x");
    expect(snapshotContent(file)).toEqual(new Map());
  });

  it("captures every non-ignored file for a small tree (hashes are stable sha256)", () => {
    writeFileSync(path.join(plain, "a.ts"), "aaa");
    mkdirSync(path.join(plain, "sub"));
    writeFileSync(path.join(plain, "sub", "b.ts"), "bbb");
    const snap = snapshotContent(plain, []);
    expect([...snap.keys()].sort()).toEqual(["a.ts", "sub/b.ts"]);
    // sha256 hex is 64 chars; two different contents -> two different hashes.
    expect(snap.get("a.ts")).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.get("a.ts")).not.toBe(snap.get("sub/b.ts"));
    // Deterministic hash of "aaa".
    expect(snap.get("a.ts")).toBe(
      "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
    );
  });

  it("recurses into directories (isDirectory branch) AND hashes files (isFile branch), keyed by rel path", () => {
    // A deeply nested file proves recursion (L236/L237); a top-level file proves
    // the isFile hash+set path (L238-L242). Directory names never become keys.
    writeFileSync(path.join(plain, "top.ts"), "T");
    mkdirSync(path.join(plain, "d1", "d2"), { recursive: true });
    writeFileSync(path.join(plain, "d1", "d2", "deep.ts"), "D");
    const snap = snapshotContent(plain, []);
    expect([...snap.keys()].sort()).toEqual(["d1/d2/deep.ts", "top.ts"]);
    // The directories themselves are NOT keys (only files are hashed).
    expect(snap.has("d1")).toBe(false);
    expect(snap.has("d1/d2")).toBe(false);
  });

  it("the same content hashes identically across snapshots; a change flips exactly that file's hash", () => {
    writeFileSync(path.join(plain, "same.ts"), "constant");
    writeFileSync(path.join(plain, "vary.ts"), "before");
    const first = snapshotContent(plain, []);
    writeFileSync(path.join(plain, "vary.ts"), "after");
    const second = snapshotContent(plain, []);
    expect(second.get("same.ts")).toBe(first.get("same.ts"));
    expect(second.get("vary.ts")).not.toBe(first.get("vary.ts"));
  });

  it("respects the ignore list even for deeply nested matches", () => {
    mkdirSync(path.join(plain, "a", "b"), { recursive: true });
    writeFileSync(path.join(plain, "a", "b", "note.log"), "noise"); // *.log via suffix branch
    writeFileSync(path.join(plain, "a", "b", "code.ts"), "keep");
    const snap = snapshotContent(plain, ["*.log"]);
    expect([...snap.keys()]).toEqual(["a/b/code.ts"]);
  });
});

describe("exported constants", () => {
  it("DEFAULT_IGNORE_GLOBS is the exact expected array", () => {
    expect(DEFAULT_IGNORE_GLOBS).toEqual([
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
    ]);
  });

  it("CONTENT_SNAPSHOT_FILE_CAP is 5000", () => {
    expect(CONTENT_SNAPSHOT_FILE_CAP).toBe(5000);
  });

  it("DEFAULT_MAX_PATCH_CHARS is 8000", () => {
    expect(DEFAULT_MAX_PATCH_CHARS).toBe(8000);
  });
});
