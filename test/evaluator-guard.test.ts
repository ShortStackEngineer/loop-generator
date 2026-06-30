import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { resolveGuardedFiles, isTestLikePath } from "../src/core/evaluator-guard";

let workdir: string;
beforeEach(() => (workdir = mkdtempSync(path.join(tmpdir(), "loopgen-eguard-"))));
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function write(rel: string, content = "original\n"): void {
  const abs = path.join(workdir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const engine = () => new LoopEngine(createDefaultRegistries(), silentLogger);

// ---------------------------------------------------------------------------
describe("isTestLikePath", () => {
  it("recognizes common test/spec file shapes", () => {
    for (const p of [
      "test/integration/foo_test.rb",
      "foo.test.ts",
      "a/b/foo-spec.js",
      "models/bar_spec.rb",
      "tests/test_helper.rb",
      "src/__tests__/x.js",
    ]) {
      expect(isTestLikePath(p)).toBe(true);
    }
  });
  it("rejects non-test files", () => {
    for (const p of ["src/app.rb", "lib/util.ts", "latest.rb", "config/test.yml"]) {
      expect(isTestLikePath(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("resolveGuardedFiles", () => {
  const spec = (evaluators: unknown[]) =>
    parseSpec({ name: "g", requirements: "x", driver: { uses: "mock" }, evaluators });

  beforeEach(() => {
    write("test/foo_test.rb");
    write("spec/bar_spec.rb");
    write("src/app.rb");
    write("contracts/c.txt");
  });

  it("auto-detects a test-like file named in a command", () => {
    const s = spec([{ uses: "command", options: { command: "bin/rails test test/foo_test.rb" } }]);
    expect(resolveGuardedFiles(s, workdir)).toEqual(["test/foo_test.rb"]);
  });

  it("does not watch a bare runner with no file args", () => {
    const s = spec([{ uses: "command", options: { command: "npm test" } }]);
    expect(resolveGuardedFiles(s, workdir)).toEqual([]);
  });

  it("ignores a directory token, flags, non-test files, and missing files", () => {
    const s = spec([
      { uses: "command", options: { command: "bin/rails test" } }, // 'test' is a dir, not a file
      { uses: "command", options: { command: "npx tsc --noEmit src/app.rb" } }, // non-test + flag
      { uses: "command", options: { command: "ruby test/missing_test.rb" } }, // does not exist
    ]);
    expect(resolveGuardedFiles(s, workdir)).toEqual([]);
  });

  it("honors an explicit guard file (even when not test-like by name)", () => {
    const s = spec([{ uses: "command", options: { command: "true" }, guard: ["contracts/c.txt"] }]);
    expect(resolveGuardedFiles(s, workdir)).toEqual(["contracts/c.txt"]);
  });

  it("expands an explicit guard directory to all its files (recursively)", () => {
    write("spec/sub/deep_spec.rb");
    write("spec/readme.md"); // explicitly guarded dir → all files watched
    const s = spec([{ uses: "command", options: { command: "true" }, guard: ["spec"] }]);
    expect(resolveGuardedFiles(s, workdir)).toEqual([
      "spec/bar_spec.rb",
      "spec/readme.md",
      "spec/sub/deep_spec.rb",
    ]);
  });

  it("rejects paths that escape the workspace and dedupes/sorts", () => {
    const s = spec([
      { uses: "command", options: { command: "x ../outside_test.rb test/foo_test.rb" } },
      { uses: "command", options: { command: "y test/foo_test.rb" } }, // duplicate
    ]);
    expect(resolveGuardedFiles(s, workdir)).toEqual(["test/foo_test.rb"]);
  });

  it("strips a leading ./ and rejects absolute paths in commands", () => {
    const s = spec([
      { uses: "command", options: { command: "ruby ./test/foo_test.rb /etc/hosts_spec.rb" } },
    ]);
    expect(resolveGuardedFiles(s, workdir)).toEqual(["test/foo_test.rb"]);
  });

  it("a guard entry resolving to the workspace root itself is ignored", () => {
    const s = spec([{ uses: "command", options: { command: "true" }, guard: ["."] }]);
    expect(resolveGuardedFiles(s, workdir)).toEqual([]);
  });

  it("skips build/vcs directories when walking a guarded directory", () => {
    write("watched/keep_test.rb");
    for (const skip of ["node_modules", ".git", "tmp", "log", "coverage", ".loopgen", "vendor", "dist"]) {
      write(`watched/${skip}/inside_test.rb`);
    }
    const s = spec([{ uses: "command", options: { command: "true" }, guard: ["watched"] }]);
    // Only the top-level file — nothing from any skipped directory.
    expect(resolveGuardedFiles(s, workdir)).toEqual(["watched/keep_test.rb"]);
  });
});

// ---------------------------------------------------------------------------
describe("evaluator-integrity guard (engine)", () => {
  it("schema defaults evaluatorGuard=warn and accepts off/error + evaluators[].guard", () => {
    const d = parseSpec({ name: "d", requirements: "x", driver: { uses: "mock" } });
    expect(d.limits.evaluatorGuard).toBe("warn");
    const s = parseSpec({
      name: "d",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", options: { command: "true" }, guard: ["a/b_test.rb"] }],
      limits: { evaluatorGuard: "error" },
    });
    expect(s.limits.evaluatorGuard).toBe("error");
    expect(s.evaluators[0]!.guard).toEqual(["a/b_test.rb"]);
    expect(() =>
      parseSpec({ name: "d", requirements: "x", driver: { uses: "mock" }, limits: { evaluatorGuard: "loud" } }),
    ).toThrow();
  });

  // Agent (mock) overwrites a test file the `command` check names, while the
  // check still passes (`true` ignores its args) — i.e. a faked green.
  const tamperSpec = (guard?: string) =>
    parseSpec({
      name: "etamper",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "test/c_test.rb": "tampered\n", "x.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "true test/c_test.rb" } }],
      limits: { maxIterations: 2, ...(guard ? { evaluatorGuard: guard } : {}) },
    });

  it("error: editing a guarded evaluator file fails an otherwise-green run", async () => {
    write("test/c_test.rb");
    const r = await engine().run(tamperSpec("error"), { baseDir: workdir });
    expect(r.outcome).toBe("evaluator-tampered");
    expect(r.success).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/evaluator depends on/);
  });

  it("warn (default): the edit is surfaced but the run still succeeds", async () => {
    write("test/c_test.rb");
    const r = await engine().run(tamperSpec(), { baseDir: workdir });
    expect(r.success).toBe(true);
    expect(r.outcome).toBe("success");
    expect(r.warnings.join("\n")).toMatch(/evaluator depends on/);
  });

  it("off: the file is not watched, no tamper warning", async () => {
    write("test/c_test.rb");
    const r = await engine().run(tamperSpec("off"), { baseDir: workdir });
    expect(r.success).toBe(true);
    expect(r.warnings.join("\n")).not.toMatch(/evaluator depends on/);
  });

  it("does not fire when the guarded file is untouched", async () => {
    write("test/c_test.rb");
    const spec = parseSpec({
      name: "clean",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "src/app.rb": "code\n" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "true test/c_test.rb" } }],
      limits: { maxIterations: 1 },
    });
    const r = await engine().run(spec, { baseDir: workdir });
    expect(r.success).toBe(true);
    expect(r.warnings.join("\n")).not.toMatch(/evaluator depends on/);
  });

  it("excludes the guarded file from the work diff (no-op guard intact)", async () => {
    execSync("git init -q", { cwd: workdir });
    write("test/c_test.rb");
    const spec = parseSpec({
      name: "excl",
      requirements: "x",
      // edits ONLY the guarded file → all "work" is excluded
      driver: { uses: "mock", options: { steps: [{ files: { "test/c_test.rb": "tampered\n" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "true test/c_test.rb" } }],
      limits: { maxIterations: 1 },
    });
    const r = await engine().run(spec, { baseDir: workdir });
    expect(r.success).toBe(true);
    expect(r.changedFiles ?? []).not.toContain("test/c_test.rb");
    expect(r.warnings.join("\n")).toMatch(/changed no files/);
  });

  it("error: honors an explicit evaluators[].guard path", async () => {
    write("contracts/special.txt");
    const spec = parseSpec({
      name: "explicit",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "contracts/special.txt": "tampered\n", "x.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" }, guard: ["contracts/special.txt"] }],
      limits: { maxIterations: 1, evaluatorGuard: "error" },
    });
    const r = await engine().run(spec, { baseDir: workdir });
    expect(r.outcome).toBe("evaluator-tampered");
    expect(r.warnings.join("\n")).toMatch(/contracts\/special\.txt/);
  });
});
