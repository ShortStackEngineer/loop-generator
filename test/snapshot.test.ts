import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { snapshotTree, commitTreeToRef } from "../src/core/workspace";

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

/** `git rev-parse <rev>` → trimmed stdout, or "" on failure. */
function revParse(dir: string, rev: string): string {
  const r = spawnSync("git", ["rev-parse", rev], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-snap-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("commitTreeToRef", () => {
  it("persists a tree as a commit under a ref without moving HEAD", () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "a.txt"), "one");
    const tree = snapshotTree(workdir);
    expect(tree).toBeTruthy();

    const oid = commitTreeToRef(workdir, "refs/loopgen/x/pre-run", tree!, "snap", null);
    expect(oid).toBeTruthy();
    // the ref resolves to our commit, and that commit's tree is the snapshot
    expect(revParse(workdir, "refs/loopgen/x/pre-run")).toBe(oid);
    expect(revParse(workdir, "refs/loopgen/x/pre-run^{tree}")).toBe(tree);
    // HEAD is untouched (a fresh repo has no HEAD commit)
    expect(revParse(workdir, "HEAD")).toBe("");
  });

  it("chains a parent into readable history", () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "a.txt"), "one");
    const t1 = snapshotTree(workdir)!;
    const root = commitTreeToRef(workdir, "refs/loopgen/x/latest", t1, "root", null)!;
    writeFileSync(path.join(workdir, "a.txt"), "two");
    const t2 = snapshotTree(workdir)!;
    const child = commitTreeToRef(workdir, "refs/loopgen/x/latest", t2, "iter", root)!;

    expect(revParse(workdir, "refs/loopgen/x/latest")).toBe(child);
    expect(revParse(workdir, `${child}^`)).toBe(root); // parent link
  });

  it("returns null for an empty tree or a non-git dir", () => {
    expect(commitTreeToRef(workdir, "refs/x", "", "m", null)).toBeNull(); // not a repo, no tree
    initGitRepo(workdir);
    expect(commitTreeToRef(workdir, "refs/x", "", "m", null)).toBeNull(); // empty tree arg
  });
});

// ---------------------------------------------------------------------------
describe("engine git snapshot (workspace.snapshot: git)", () => {
  const convergingSpec = (over: Record<string, unknown> = {}) =>
    parseSpec({
      name: "snap",
      requirements: "write 42 to answer.txt",
      workspace: { dir: ".", snapshot: "git" },
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 3, baseline: false },
      ...over,
    });

  it("checkpoints the run into refs and reports inspect/reset commands", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "answer.txt"), "wrong");

    const report = await engine().run(convergingSpec(), { baseDir: workdir });
    expect(report.success).toBe(true);

    const snap = report.snapshot;
    expect(snap).toBeDefined();
    expect(snap!.preRunRef).toMatch(/^refs\/loopgen\/.+\/pre-run$/);
    expect(snap!.latestRef).toMatch(/^refs\/loopgen\/.+\/latest$/);
    expect(snap!.checkpoints).toBe(1); // one iteration changed the file
    expect(snap!.resetCommand).toContain(snap!.preRunRef);
    expect(snap!.inspectCommand).toContain(snap!.latestRef!);

    // the refs actually exist and differ (agent changed the tree)
    expect(revParse(workdir, snap!.preRunRef)).toBeTruthy();
    expect(revParse(workdir, snap!.latestRef!)).toBeTruthy();
    expect(revParse(workdir, `${snap!.preRunRef}^{tree}`)).not.toBe(
      revParse(workdir, `${snap!.latestRef}^{tree}`),
    );
  });

  it("pre-run ref captures the ORIGINAL state, so a reset undoes the agent's work", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "answer.txt"), "wrong");

    const report = await engine().run(convergingSpec(), { baseDir: workdir });
    const snap = report.snapshot!;

    // after the run the agent's change is live
    expect(readFileSync(path.join(workdir, "answer.txt"), "utf8")).toBe("42");
    // reset (the exact ops the reported command runs) restores the pre-run state
    spawnSync("git", ["checkout", snap.preRunRef, "--", "."], { cwd: workdir });
    spawnSync("git", ["clean", "-fd"], { cwd: workdir });
    expect(readFileSync(path.join(workdir, "answer.txt"), "utf8")).toBe("wrong");
  });

  it("emits paste-safe commands for a workspace path containing spaces", async () => {
    // A macOS-style path with spaces must survive copy-paste into a shell.
    const spaced = mkdtempSync(path.join(tmpdir(), "loopgen snap ")); // note the spaces
    try {
      initGitRepo(spaced);
      writeFileSync(path.join(spaced, "answer.txt"), "wrong");
      const report = await engine().run(convergingSpec(), { baseDir: spaced });
      const snap = report.snapshot!;
      // workdir is single-quoted in both commands
      expect(snap.resetCommand).toContain(`'${spaced}'`);
      expect(snap.inspectCommand).toContain(`'${spaced}'`);
      // the reported reset command runs as-is in a shell (would fail if the
      // spaced path weren't quoted — `git -C` would get split arguments)
      const reset = spawnSync("sh", ["-c", snap.resetCommand], { encoding: "utf8" });
      expect(reset.status).toBe(0);
      expect(readFileSync(path.join(spaced, "answer.txt"), "utf8")).toBe("wrong");
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });

  it("writes NO refs and reports no snapshot when snapshot is 'none' (default)", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "answer.txt"), "wrong");

    const report = await engine().run(convergingSpec({ workspace: { dir: ".", snapshot: "none" } }), {
      baseDir: workdir,
    });
    expect(report.success).toBe(true);
    expect(report.snapshot).toBeUndefined();
    // no loopgen refs were created
    const refs = spawnSync("git", ["for-each-ref", "refs/loopgen"], { cwd: workdir, encoding: "utf8" });
    expect(refs.stdout.trim()).toBe("");
  });

  it("degrades to no snapshot when snapshot is 'git' but the workspace is not a repo", async () => {
    // no initGitRepo → content-hash fallback path. skipPreflight sidesteps the
    // (unrelated) SPEC-WORKDIR-NOT-PROJECT check that snapshot:"git" also trips
    // off-git; we're isolating the snapshot-degradation behavior here.
    writeFileSync(path.join(workdir, "answer.txt"), "wrong");
    const report = await engine().run(convergingSpec(), { baseDir: workdir, skipPreflight: true });
    expect(report.success).toBe(true);
    expect(report.snapshot).toBeUndefined();
  });
});
