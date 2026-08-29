import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateSpec, specToYaml, runRedCheck, verifySpec, defaultDriverOptions } from "../src/generate";
import { parseSpec, type LoopSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";

let workdir: string;
beforeEach(() => (workdir = mkdtempSync(path.join(tmpdir(), "loopgen-generate-"))));
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

/** A minimal, schema-valid spec with the given evaluators. */
function specWith(evaluators: LoopSpec["evaluators"], success?: LoopSpec["success"]): LoopSpec {
  return parseSpec({
    name: "t",
    requirements: "r",
    driver: { uses: "mock" },
    evaluators,
    ...(success ? { success } : {}),
  });
}

describe("generateSpec safer defaults", () => {
  it("defaults to a safe baseline posture (baseline on, git change detection on)", () => {
    const spec = generateSpec({ name: "G", taskType: "function", language: "typescript", requirements: "x" });
    expect(spec.limits.baseline).toBe(true);
    expect(spec.workspace.snapshot).toBe("git");
  });

  it("keeps the safe defaults visible in the serialized YAML", () => {
    const yaml = specToYaml(
      generateSpec({ name: "G", taskType: "function", language: "typescript", requirements: "x" }),
    );
    expect(yaml).toContain("baseline: true");
    expect(yaml).toContain("snapshot: git");
  });

  it("still honors an explicit workspace dir and iteration override", () => {
    const spec = generateSpec({
      name: "G",
      taskType: "function",
      language: "typescript",
      requirements: "x",
      workspaceDir: "sub",
      maxIterations: 3,
    });
    expect(spec.workspace.dir).toBe("sub");
    expect(spec.limits.maxIterations).toBe(3);
    // Overrides don't disable the safe posture.
    expect(spec.limits.baseline).toBe(true);
    expect(spec.workspace.snapshot).toBe("git");
  });

  it("seeds opencode headless options so a generated spec shows the required flags", () => {
    const spec = generateSpec({
      name: "G",
      taskType: "function",
      language: "typescript",
      requirements: "x",
      driver: "opencode",
    });
    expect(spec.driver.uses).toBe("opencode");
    expect(spec.driver.options).toEqual({ dangerouslySkipPermissions: true });
    expect(specToYaml(spec)).toContain("dangerouslySkipPermissions: true");
  });

  it("merges caller-supplied opencode options on top of the headless seed", () => {
    const spec = generateSpec({
      name: "G",
      taskType: "function",
      language: "typescript",
      requirements: "x",
      driver: "opencode",
      driverOptions: { model: "lmstudio/qwen/qwen3-coder-next" },
    });
    expect(spec.driver.options).toEqual({
      dangerouslySkipPermissions: true,
      model: "lmstudio/qwen/qwen3-coder-next",
    });
  });

  it("lets an explicit dangerouslySkipPermissions: false win", () => {
    const spec = generateSpec({
      name: "G",
      taskType: "function",
      language: "typescript",
      requirements: "x",
      driver: "opencode",
      driverOptions: { dangerouslySkipPermissions: false },
    });
    expect(spec.driver.options.dangerouslySkipPermissions).toBe(false);
  });

  it("does not seed options for other drivers", () => {
    expect(defaultDriverOptions("claude-agent-sdk")).toEqual({});
    expect(defaultDriverOptions("mock")).toEqual({});
    const spec = generateSpec({ name: "G", taskType: "function", language: "typescript", requirements: "x" });
    expect(spec.driver.options).toEqual({});
  });
});

describe("runRedCheck", () => {
  it("reports RED when at least one evaluator fails before any agent work", async () => {
    const spec = specWith([
      { uses: "command", as: "passes", options: { command: "true" } },
      { uses: "command", as: "fails", options: { command: "false" } },
    ]);
    const red = await runRedCheck(spec, { workdir, log: silentLogger });
    expect(red.startsRed).toBe(true);
    expect(red.noEvaluators).toBe(false);
    expect(red.evaluations.map((e) => [e.name, e.passed])).toEqual([
      ["passes", true],
      ["fails", false],
    ]);
  });

  it("reports GREEN (not RED) when every evaluator already passes", async () => {
    const spec = specWith([
      { uses: "command", as: "a", options: { command: "true" } },
      { uses: "command", as: "b", options: { command: "true" } },
    ]);
    const red = await runRedCheck(spec, { workdir, log: silentLogger });
    expect(red.startsRed).toBe(false);
    expect(red.evaluations.every((e) => e.passed && e.ok)).toBe(true);
  });

  it("cannot prove RED when the spec declares no evaluators", async () => {
    const spec = specWith([]);
    const red = await runRedCheck(spec, { workdir, log: silentLogger });
    expect(red.noEvaluators).toBe(true);
    expect(red.startsRed).toBe(false);
  });

  it("records an unresolvable evaluator type as ok:false and treats it as non-passing", async () => {
    // Bypass generate/schema resolution to inject an unknown evaluator type.
    const spec = specWith([{ uses: "command", as: "ok-check", options: { command: "true" } }]);
    (spec.evaluators as unknown[]).push({ uses: "does-not-exist", as: "bogus", options: {} });
    const red = await runRedCheck(spec, { workdir, log: silentLogger });
    const bogus = red.evaluations.find((e) => e.name === "bogus");
    expect(bogus?.ok).toBe(false);
    expect(bogus?.passed).toBe(false);
    // A non-passing evaluator makes the check RED.
    expect(red.startsRed).toBe(true);
  });

  it("runs against the given workspace directory", async () => {
    // `test -f marker` only passes when the file exists in workdir.
    const spec = specWith([{ uses: "command", as: "marker", options: { command: "test -f marker.txt" } }]);
    const before = await runRedCheck(spec, { workdir, log: silentLogger });
    expect(before.startsRed).toBe(true); // no marker yet → fails → RED

    writeFileSync(path.join(workdir, "marker.txt"), "");
    const after = await runRedCheck(spec, { workdir, log: silentLogger });
    expect(after.startsRed).toBe(false); // marker present → passes → GREEN
  });
});

describe("verifySpec", () => {
  it("passes when lint is clean and the checks start RED", async () => {
    // snapshot "none" + a bare `false` check means lint has nothing to flag
    // against an existing dir; the failing check proves RED.
    const spec = specWith([{ uses: "command", as: "fails", options: { command: "false" } }]);
    const result = await verifySpec(spec, { workdir });
    expect(result.lintErrors).toBe(0);
    expect(result.red.startsRed).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails when the checks are already GREEN (vacuous baseline)", async () => {
    const spec = specWith([{ uses: "command", as: "passes", options: { command: "true" } }]);
    const result = await verifySpec(spec, { workdir });
    expect(result.red.startsRed).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("surfaces lint errors and fails a generated spec against a non-project workdir", async () => {
    // A generated spec defaults to snapshot:"git", so lint expects an existing
    // project; an empty non-git temp dir trips SPEC-WORKDIR-NOT-PROJECT (error).
    const spec = generateSpec({ name: "G", taskType: "function", language: "typescript", requirements: "x" });
    const result = await verifySpec(spec, { workdir });
    expect(result.lintErrors).toBeGreaterThan(0);
    expect(result.lint.some((f) => f.ruleId === "SPEC-WORKDIR-NOT-PROJECT")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("with strict, treats lint warnings as a failure but non-strict tolerates them", async () => {
    // A missing workdir yields exactly one warning (SPEC-WORKDIR-MISSING) and no
    // error, and the check can't run there → RED.
    const missing = path.join(workdir, "does-not-exist");
    const spec = specWith([{ uses: "command", as: "fails", options: { command: "false" } }]);

    const strict = await verifySpec(spec, { workdir: missing, strict: true });
    expect(strict.lintErrors).toBe(0);
    expect(strict.lintWarnings).toBeGreaterThan(0);
    expect(strict.ok).toBe(false); // warnings block under strict

    const lax = await verifySpec(spec, { workdir: missing, strict: false });
    expect(lax.red.startsRed).toBe(true);
    expect(lax.ok).toBe(true); // warnings tolerated; RED satisfied
  });
});
