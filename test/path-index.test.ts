import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { preflightFail } from "../src/core/preflight";
import type { AgentDriver } from "../src/drivers/types";
import {
  PATH_INDEX_RELATIVE,
  PathIndexReadError,
  PathIndexWriteError,
  entriesForChangedFiles,
  formatPathLookup,
  lookupRunByPath,
  pathIndexPath,
  readPathIndex,
  recordPathIndex,
  type PathIndex,
  type PathIndexEntry,
} from "../src/core/path-index";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

function entry(over: Partial<PathIndexEntry> = {}): PathIndexEntry {
  return {
    path: "answer.txt",
    hash: sha("42"),
    runId: "run-1",
    iteration: 0,
    ...over,
  };
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-path-index-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("entriesForChangedFiles", () => {
  it("hashes post-iteration bytes, prefers a known hash, and drops bookkeeping paths", () => {
    writeFileSync(path.join(workdir, "answer.txt"), "on-disk");
    mkdirSync(path.join(workdir, "nested"));
    writeFileSync(path.join(workdir, "nested", "note.txt"), "n");

    const fromDisk = entriesForChangedFiles(
      workdir,
      ["./answer.txt", "answer.txt", ".loopgen/challenge.json", "../outside", "foo/../x", "foo//bar", "foo/./bar", "nested/note.txt", "missing.txt"],
      "run-1",
      0,
    );
    expect(fromDisk.map((e) => e.path)).toEqual(["answer.txt", "nested/note.txt", "missing.txt"]);
    expect(fromDisk[0]).toMatchObject({ hash: sha("on-disk"), runId: "run-1", iteration: 0 });
    expect(fromDisk[2]!.hash).toBeNull();

    const known = entriesForChangedFiles(workdir, ["answer.txt"], "run-1", 1, new Map([["answer.txt", sha("other")]]));
    expect(known[0]!.hash).toBe(sha("other"));

    mkdirSync(path.join(workdir, "adir"));
    const fallback = entriesForChangedFiles(workdir, ["answer.txt", "adir", "foo\\bar.txt"], "run-1", 2, new Map());
    expect(fallback.map((e) => [e.path, e.hash])).toEqual([
      ["answer.txt", sha("on-disk")],
      ["adir", null],
      ["foo/bar.txt", null],
    ]);
    expect(entriesForChangedFiles(workdir, ["answer.txt"], "run-1", 0, null)[0]!.hash).toBe(sha("on-disk"));
  });
});

describe("path index file", () => {
  it("merges entries across writes and does not repeat an identical tuple", () => {
    const file = recordPathIndex(workdir, [entry({ hash: sha("wrong"), iteration: 0 })]);
    recordPathIndex(workdir, [
      entry({ hash: sha("wrong"), iteration: 0 }),
      entry({ hash: sha("42"), iteration: 1 }),
    ]);
    const index = readPathIndex(workdir);
    expect(file).toBe(pathIndexPath(workdir));
    expect(index).toMatchObject({ kind: "loopgen.path-index", version: 1 });
    expect(index!.entries).toEqual([
      entry({ hash: sha("wrong"), iteration: 0 }),
      entry({ hash: sha("42"), iteration: 1 }),
    ]);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("looks up a path from the index without a driver", () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42");
    recordPathIndex(workdir, [
      entry({ hash: sha("wrong"), iteration: 0 }),
      entry({ hash: sha("42"), iteration: 1, runId: "run-2" }),
    ]);

    const hit = lookupRunByPath(workdir, "./answer.txt");
    expect(hit).toMatchObject({ path: "answer.txt", runId: "run-2", iteration: 1, hash: sha("42"), matchesContent: true });
    expect(formatPathLookup(hit, "answer.txt")).toContain("run: run-2");
    expect(formatPathLookup(null, "nope.txt")).toBe("no run recorded for nope.txt");

    writeFileSync(path.join(workdir, "answer.txt"), "wrong");
    expect(lookupRunByPath(workdir, "answer.txt")).toMatchObject({ runId: "run-1", iteration: 0, matchesContent: true });

    writeFileSync(path.join(workdir, "answer.txt"), "hand-edit");
    expect(lookupRunByPath(workdir, "answer.txt")).toMatchObject({
      runId: "run-2",
      iteration: 1,
      matchesContent: false,
    });
    expect(formatPathLookup(lookupRunByPath(workdir, "answer.txt"), "answer.txt")).toContain("differs");
  });

  it("treats a missing file as a match for a null hash", () => {
    recordPathIndex(workdir, [entry({ path: "gone.txt", hash: null })]);
    expect(lookupRunByPath(workdir, "gone.txt")).toMatchObject({ hash: null, matchesContent: true });
    expect(formatPathLookup(lookupRunByPath(workdir, "gone.txt"), "gone.txt")).toContain("(deleted)");
    writeFileSync(path.join(workdir, "gone.txt"), "back");
    expect(lookupRunByPath(workdir, "gone.txt")?.matchesContent).toBe(false);
  });

  it("returns null when nothing is recorded or the path escapes the workspace", () => {
    expect(readPathIndex(workdir)).toBeNull();
    expect(lookupRunByPath(workdir, "answer.txt")).toBeNull();
    recordPathIndex(workdir, [entry()]);
    expect(lookupRunByPath(workdir, "other.txt")).toBeNull();
    expect(lookupRunByPath(workdir, "../answer.txt")).toBeNull();
    expect(lookupRunByPath(workdir, ".loopgen/path-index.json")).toBeNull();
    expect(lookupRunByPath(workdir, "/etc/passwd")).toBeNull();
  });

  it("refuses to replace an unreadable index and refuses to guess on lookup", () => {
    const file = pathIndexPath(workdir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not json");
    expect(() => recordPathIndex(workdir, [entry()])).toThrow(PathIndexWriteError);
    expect(readFileSync(file, "utf8")).toBe("not json");
    expect(() => lookupRunByPath(workdir, "answer.txt")).toThrow(PathIndexReadError);
    expect(() => readPathIndex(workdir)).toThrow(PathIndexReadError);

    writeFileSync(file, '{"kind":"nope"}\n');
    expect(() => readPathIndex(workdir)).toThrow(PathIndexReadError);
  });

  it("rejects an entry that is not a path/hash/run record and leaves a valid index in place", () => {
    recordPathIndex(workdir, [entry()]);
    const before = readFileSync(pathIndexPath(workdir), "utf8");
    expect(() => recordPathIndex(workdir, [entry({ hash: "not-a-sha" })])).toThrow(PathIndexWriteError);
    expect(readFileSync(pathIndexPath(workdir), "utf8")).toBe(before);
  });

  it("throws when the index path cannot be written", () => {
    mkdirSync(path.join(workdir, ".loopgen", "path-index.json"), { recursive: true });
    expect(() => recordPathIndex(workdir, [entry()])).toThrow(PathIndexWriteError);
    expect(() => readPathIndex(workdir)).toThrow(PathIndexReadError);

    rmSync(path.join(workdir, ".loopgen"), { recursive: true, force: true });
    writeFileSync(path.join(workdir, ".loopgen"), "not a directory");
    expect(() => recordPathIndex(workdir, [entry()])).toThrow(PathIndexWriteError);
  });
});

describe("engine path index", () => {
  it("maps each iteration's path and post-iteration hash to the run", async () => {
    const spec = parseSpec({
      name: "two-step",
      requirements: "write 42",
      driver: {
        uses: "mock",
        options: {
          steps: [{ files: { "answer.txt": "wrong" } }, { files: { "answer.txt": "42" } }],
        },
      },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 5, baseline: false },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    const index = JSON.parse(readFileSync(pathIndexPath(workdir), "utf8")) as PathIndex;

    expect(report.success).toBe(true);
    expect(report.pathIndex).toBe(pathIndexPath(workdir));
    expect(report.pathIndex?.endsWith(PATH_INDEX_RELATIVE)).toBe(true);
    expect(index.entries).toEqual([
      { path: "answer.txt", hash: sha("wrong"), runId: report.runId, iteration: 0 },
      { path: "answer.txt", hash: sha("42"), runId: report.runId, iteration: 1 },
    ]);
    expect(lookupRunByPath(workdir, "answer.txt")).toMatchObject({
      runId: report.runId,
      iteration: 1,
      hash: sha("42"),
      matchesContent: true,
    });
    expect(report.changedFiles ?? []).not.toContain(".loopgen/path-index.json");
    expect(report.changedFiles ?? []).not.toContain(".loopgen/challenge.json");
  });

  it("keeps an earlier run when a later run overwrites the challenge packet", async () => {
    const firstSpec = parseSpec({
      name: "first",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const first = await engine().run(firstSpec, { baseDir: workdir });

    const secondSpec = parseSpec({
      name: "second",
      requirements: "write 99",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "99" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "99"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const second = await engine().run(secondSpec, { baseDir: workdir });
    const index = readPathIndex(workdir)!;

    expect(lookupRunByPath(workdir, "answer.txt")).toMatchObject({
      runId: second.runId,
      hash: sha("99"),
      matchesContent: true,
    });
    expect(index.entries).toEqual([
      { path: "answer.txt", hash: sha("42"), runId: first.runId, iteration: 0 },
      { path: "answer.txt", hash: sha("99"), runId: second.runId, iteration: 0 },
    ]);

    writeFileSync(path.join(workdir, "answer.txt"), "42");
    expect(lookupRunByPath(workdir, "answer.txt")).toMatchObject({ runId: first.runId, matchesContent: true });
  });

  it("records a deletion and does not treat the index as agent work under git", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "gone.txt"), "bye");
    writeFileSync(path.join(workdir, "answer.txt"), "wrong");
    const spec = parseSpec({
      name: "delete",
      requirements: "remove gone.txt and write 42",
      driver: {
        uses: "mock",
        options: { steps: [{ deleteFiles: ["gone.txt"], files: { "answer.txt": "42" } }] },
      },
      evaluators: [
        {
          uses: "command",
          as: "check",
          options: { command: `test ! -e gone.txt && test "$(cat answer.txt)" = "42"` },
        },
      ],
      limits: { maxIterations: 2, baseline: false },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.changedFiles?.sort()).toEqual(["answer.txt", "gone.txt"]);
    expect(lookupRunByPath(workdir, "gone.txt")).toMatchObject({
      runId: report.runId,
      iteration: 0,
      hash: null,
      matchesContent: true,
    });
    expect(lookupRunByPath(workdir, "answer.txt")?.hash).toBe(sha("42"));
  });

  it("leaves the vacuous-success warning in place when the agent changes nothing", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "answer.txt"), "42");
    const spec = parseSpec({
      name: "noop",
      requirements: "leave it",
      driver: { uses: "mock", options: { steps: [{ summary: "did nothing" }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 1, baseline: false },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.warnings.join(" ")).toMatch(/changed no files/i);
    expect(report.changedFiles).toEqual([]);
    expect(readPathIndex(workdir)!.entries).toEqual([]);
    expect(lookupRunByPath(workdir, "answer.txt")).toBeNull();
  });

  it("writes an empty index when preflight fails before any agent turn", async () => {
    const failing: AgentDriver = {
      name: "failing-preflight",
      async preflight() {
        return preflightFail(["binary missing"]);
      },
      async run() {
        throw new Error("agent must not run");
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.register(failing);
    const spec = parseSpec({
      name: "preflight",
      requirements: "never reached",
      driver: { uses: "failing-preflight" },
      limits: { maxIterations: 1 },
    });

    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("preflight-failed");
    expect(readPathIndex(workdir)!.entries).toEqual([]);
    expect(lookupRunByPath(workdir, "answer.txt")).toBeNull();
  });

  it("does not finish when the path index cannot be written", async () => {
    mkdirSync(path.join(workdir, ".loopgen", "path-index.json"), { recursive: true });
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "does-not-exist" },
    });

    await expect(engine().run(spec, { baseDir: workdir })).rejects.toBeInstanceOf(PathIndexWriteError);
  });
});

describe("loopgen lookup", () => {
  it("prints the run for a path and does not start an agent", async () => {
    const spec = parseSpec({
      name: "lookup",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    const tsx = path.resolve("node_modules/.bin/tsx");
    const cli = path.resolve("src/cli/index.ts");

    const hit = spawnSync(tsx, [cli, "lookup", "answer.txt", "-w", workdir], { encoding: "utf8" });
    expect(hit.status).toBe(0);
    expect(hit.stdout).toContain(`run: ${report.runId}`);
    expect(hit.stdout).toContain("iteration: 0");
    expect(hit.stdout).toContain("content: matches");
    expect(hit.stdout).not.toMatch(/starting iteration/i);

    const json = spawnSync(tsx, [cli, "lookup", "answer.txt", "-w", workdir, "--json"], { encoding: "utf8" });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ runId: report.runId, iteration: 0, matchesContent: true });

    const miss = spawnSync(tsx, [cli, "lookup", "missing.txt", "-w", workdir], { encoding: "utf8" });
    expect(miss.status).toBe(1);
    expect(miss.stdout).toContain("no run recorded for missing.txt");

    writeFileSync(pathIndexPath(workdir), "{");
    const bad = spawnSync(tsx, [cli, "lookup", "answer.txt", "-w", workdir], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Could not read path index/);
  });
});
