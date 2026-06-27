import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger, silentLogger } from "../src/core/logger";
import { Registry } from "../src/core/registry";
import { preflightOk, preflightFail, mergePreflight } from "../src/core/preflight";
import { buildFeedback } from "../src/core/feedback";
import { evaluateCriteria, describeCriteria } from "../src/core/criteria";
import { runCommand, tail } from "../src/core/exec";
import { loadSpecFile, parseSpec, resolveWorkspaceDir, SpecValidationError } from "../src/core/spec";
import { isGitRepo, isIgnored, changeDetectionAvailable, snapshotTree, diffTrees } from "../src/core/workspace";
import type { EvaluationResult } from "../src/evaluators/types";

afterEach(() => vi.restoreAllMocks());

function evalResult(name: string, passed: boolean, score?: number): EvaluationResult {
  return { name, type: "command", ok: true, passed, score, feedback: `${name} feedback`, durationMs: 1 };
}

describe("logger", () => {
  it("gates by level and prefixes child scopes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("warn", "root");
    log.debug("nope"); // below threshold
    log.info("nope"); // below threshold
    log.warn("yep"); // -> console.warn
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("[root]");

    log.child("sub").error("boom"); // -> console.error
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain("[root:sub]");
  });

  it("silent logger emits nothing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    silentLogger.error("x");
    silentLogger.warn("x");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Registry", () => {
  const make = () => new Registry<{ name: string }>("widget", (w) => w.name);

  it("registers, gets, and lists", () => {
    const r = make().register({ name: "a" }).register({ name: "b" });
    expect(r.get("a").name).toBe("a");
    expect(r.keys()).toEqual(["a", "b"]);
    expect(r.list()).toHaveLength(2);
    expect(r.has("a")).toBe(true);
    expect(r.tryGet("missing")).toBeUndefined();
  });

  it("rejects duplicates but allows override", () => {
    const r = make().register({ name: "a" });
    expect(() => r.register({ name: "a" })).toThrow(/already registered/);
    r.override({ name: "a" });
    expect(r.get("a").name).toBe("a");
  });

  it("throws an informative error for an unknown key", () => {
    const r = make().register({ name: "a" });
    expect(() => r.get("zzz")).toThrow(/Unknown widget "zzz".*Available: a/);
  });

  it("rejects an empty key", () => {
    expect(() => make().register({ name: "" })).toThrow(/empty key/);
  });
});

describe("preflight helpers", () => {
  it("constructs ok/fail and merges", () => {
    expect(preflightOk(["n"]).ok).toBe(true);
    expect(preflightFail(["e"]).ok).toBe(false);
    const merged = mergePreflight([preflightOk(["n1"], ["w1"]), preflightFail(["e1"], ["w2"])]);
    expect(merged.ok).toBe(false);
    expect(merged.errors).toEqual(["e1"]);
    expect(merged.warnings).toEqual(["w1", "w2"]);
    expect(merged.notes).toEqual(["n1"]);
    expect(mergePreflight([preflightOk()]).ok).toBe(true);
  });
});

describe("buildFeedback", () => {
  it("separates failing and passing checks and reports overall", () => {
    const results = [evalResult("tests", false, 1), evalResult("lint", true)];
    const fb = buildFeedback(results, { satisfied: false, reason: "failing: tests" });
    expect(fb.passed).toBe(false);
    expect(fb.text).toContain("NOT YET");
    expect(fb.text).toContain("Failing checks");
    expect(fb.text).toContain("Passing checks");
    expect(fb.text).toContain("tests");
  });

  it("truncates oversized feedback but keeps head and tail", () => {
    const feedback = `HEAD_MARKER${"x".repeat(10_000)}TAIL_MARKER`;
    const big = { ...evalResult("tests", false), feedback };
    const fb = buildFeedback([big], { satisfied: false, reason: "r" }, { maxCharsPerCheck: 200 });
    expect(fb.text).toContain("chars omitted");
    expect(fb.text).toContain("HEAD_MARKER");
    expect(fb.text).toContain("TAIL_MARKER");
  });

  it("lists passing checks with their type and score", () => {
    const fb = buildFeedback([evalResult("cov", true, 0.95)], { satisfied: true, reason: "ok" });
    expect(fb.text).toContain("- cov [command]");
    expect(fb.text).toContain("score 0.95");
  });
});

describe("describeCriteria", () => {
  it("renders every node type", () => {
    expect(describeCriteria({ type: "all-pass" })).toMatch(/all checks/);
    expect(describeCriteria({ type: "pass", evaluators: ["t"] })).toContain("t");
    expect(describeCriteria({ type: "score", evaluator: "m", gte: 1, lte: 2, eq: 3 })).toContain("m");
    expect(describeCriteria({ type: "score", evaluator: "m" })).toContain("is produced");
    expect(
      describeCriteria({ type: "all", of: [{ type: "all-pass" }, { type: "pass", evaluators: ["t"] }] }),
    ).toContain("AND");
    expect(
      describeCriteria({ type: "any", of: [{ type: "all-pass" }, { type: "pass", evaluators: ["t"] }] }),
    ).toContain("OR");
    expect(describeCriteria({ type: "not", of: { type: "all-pass" } })).toContain("NOT");
  });
});

describe("evaluateCriteria edge cases", () => {
  it("score with no numeric score is unsatisfied", () => {
    const r = [evalResult("m", true)];
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 1 }, r).satisfied).toBe(false);
  });
  it("pass naming a missing evaluator reports it", () => {
    const v = evaluateCriteria({ type: "pass", evaluators: ["ghost"] }, [evalResult("m", true)]);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/unknown evaluator/);
  });
  it("score on a missing evaluator reports it", () => {
    const v = evaluateCriteria({ type: "score", evaluator: "ghost", gte: 1 }, []);
    expect(v.reason).toMatch(/unknown evaluator/);
  });
});

describe("runCommand", () => {
  const mkdir = () => mkdtempSync(path.join(tmpdir(), "loopgen-exec-"));

  it("captures success output", async () => {
    const dir = mkdir();
    const r = await runCommand("echo hello", { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.combined).toContain("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports non-zero exit", async () => {
    const dir = mkdir();
    const r = await runCommand("exit 3", { cwd: dir });
    expect(r.code).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("times out long commands", async () => {
    const dir = mkdir();
    const r = await runCommand("sleep 5", { cwd: dir, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when the signal is already aborted", async () => {
    const dir = mkdir();
    await expect(runCommand("echo x", { cwd: dir, signal: AbortSignal.abort() })).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes extra environment variables", async () => {
    const dir = mkdir();
    const r = await runCommand("echo $LOOPGEN_MARKER", { cwd: dir, env: { LOOPGEN_MARKER: "present" } });
    expect(r.stdout).toContain("present");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tail trims the head and keeps exactly the trailing chars", () => {
    const out = tail("abcdef", 3);
    expect(out).toContain("earlier chars omitted");
    expect(out.endsWith("def")).toBe(true);
    expect(out).not.toContain("abc\n");
    expect(tail("ab", 5)).toBe("ab");
  });
});

describe("spec loading", () => {
  it("loads and resolves a spec file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-spec-"));
    const file = path.join(dir, "x.loop.yaml");
    writeFileSync(file, "name: x\nrequirements: do\ndriver: { uses: mock }\n");
    const { spec, baseDir } = loadSpecFile(file);
    expect(spec.name).toBe("x");
    expect(resolveWorkspaceDir(spec, baseDir)).toBe(path.resolve(baseDir, "."));
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws for a missing file", () => {
    expect(() => loadSpecFile("/no/such/file.loop.yaml")).toThrow(/Could not read/);
  });

  it("throws for invalid yaml", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-spec-"));
    const file = path.join(dir, "bad.loop.yaml");
    writeFileSync(file, "name: x\n\tbad: : :\n");
    expect(() => loadSpecFile(file)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces validation errors with field paths", () => {
    expect(() => parseSpec({ driver: { uses: "mock" } })).toThrow(SpecValidationError);
  });
});

describe("workspace git helpers", () => {
  it("reports non-repos and null snapshots", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-nogit-"));
    expect(isGitRepo(dir)).toBe(false);
    expect(snapshotTree(dir)).toBeNull();
    expect(changeDetectionAvailable(dir)).toBe(false);
    expect(diffTrees(dir, null, "x")).toEqual({ changed: false, files: [], stat: "" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots and diffs a real repo, ignoring artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-git-"));
    const git = (args: string[]) => spawnSync("git", args, { cwd: dir });
    git(["init"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
    writeFileSync(path.join(dir, "a.txt"), "1");
    expect(isGitRepo(dir)).toBe(true);
    expect(changeDetectionAvailable(dir)).toBe(true);

    const before = snapshotTree(dir)!;
    writeFileSync(path.join(dir, "a.txt"), "2");
    mkdirSync(path.join(dir, "log"), { recursive: true });
    writeFileSync(path.join(dir, "log", "x.log"), "noise");
    const after = snapshotTree(dir)!;

    const diff = diffTrees(dir, before, after); // default ignore globs exclude log/
    expect(diff.changed).toBe(true);
    expect(diff.files).toContain("a.txt");
    expect(diff.files.some((f) => f.startsWith("log/"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects an ignored workspace dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-git-"));
    const git = (args: string[]) => spawnSync("git", args, { cwd: dir });
    git(["init"]);
    writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    mkdirSync(path.join(dir, "ignored"), { recursive: true });
    expect(isIgnored(path.join(dir, "ignored"))).toBe(true);
    expect(changeDetectionAvailable(path.join(dir, "ignored"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
