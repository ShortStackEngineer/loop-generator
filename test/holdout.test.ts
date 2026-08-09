import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine, extractCommandText } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { resolveHoldouts, materializeHoldouts } from "../src/core/holdout";
import { lintSpec } from "../src/lint/spec-lint";

/**
 * Holdout evaluators: graders live outside the workspace and are materialized
 * only while evaluators run, so the agent's only signal is failure feedback.
 */

let root: string; // parent temp dir: holds the workspace AND the out-of-workspace graders
let workdir: string;
let graderDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "loopgen-holdout-"));
  workdir = path.join(root, "app");
  graderDir = path.join(root, "graders");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(graderDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const engine = () => new LoopEngine(createDefaultRegistries(), silentLogger);

/** A grader script that passes only once the agent has produced answer.txt=42. */
const GRADER = `#!/bin/sh\ntest "$(cat answer.txt 2>/dev/null)" = "42"\n`;

const holdoutSpec = (over: Record<string, unknown> = {}) =>
  parseSpec({
    name: "holdout",
    requirements: "produce answer.txt containing 42",
    workspace: { dir: "app" },
    driver: {
      uses: "mock",
      // The mock "agent" also tries to exfiltrate the grader: if grader.sh is
      // visible during its turn, it copies it to leaked.txt.
      options: {
        steps: [{ files: { "answer.txt": "42" }, run: "cp grader.sh leaked.txt 2>/dev/null; true" }],
      },
    },
    evaluators: [
      {
        uses: "command",
        as: "tests",
        options: { command: "sh grader.sh" },
        holdout: [{ from: "graders/grader.sh", to: "grader.sh" }],
      },
    ],
    limits: { maxIterations: 2, baseline: "strict" },
    ...(over as object),
  });

// ---------------------------------------------------------------------------
describe("schema", () => {
  it("parses holdout mappings and rejects empty paths", () => {
    const s = holdoutSpec();
    expect(s.evaluators[0]?.holdout).toEqual([{ from: "graders/grader.sh", to: "grader.sh" }]);
    expect(() =>
      parseSpec({
        name: "bad",
        requirements: "x",
        driver: { uses: "mock" },
        evaluators: [{ uses: "command", options: {}, holdout: [{ from: "", to: "x" }] }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("resolveHoldouts", () => {
  it("errors on a missing source and an escaping destination", () => {
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [
        {
          uses: "command",
          as: "c",
          options: { command: "true" },
          holdout: [
            { from: "graders/nope.sh", to: "ok.sh" },
            { from: "graders/nope.sh", to: "../escape.sh" },
          ],
        },
      ],
    });
    const r = resolveHoldouts(spec, root, workdir);
    expect(r.mappings).toHaveLength(0);
    expect(r.errors.join("\n")).toMatch(/not found/);
    expect(r.errors.join("\n")).toMatch(/escapes the workspace/);
  });

  it("warns when the source itself is agent-visible (inside the workspace)", () => {
    writeFileSync(path.join(workdir, "visible.sh"), GRADER);
    const spec = parseSpec({
      name: "vis",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [
        { uses: "command", as: "c", options: { command: "true" }, holdout: [{ from: "app/visible.sh", to: "g.sh" }] },
      ],
    });
    const r = resolveHoldouts(spec, root, workdir);
    expect(r.errors).toHaveLength(0);
    expect(r.mappings).toHaveLength(1);
    expect(r.warnings.join("\n")).toMatch(/defeats the holdout/);
  });
});

// ---------------------------------------------------------------------------
describe("materializeHoldouts", () => {
  it("copies the grader in and restore removes it", () => {
    writeFileSync(path.join(graderDir, "g.sh"), GRADER);
    const m = materializeHoldouts([{ evaluator: "c", from: path.join(graderDir, "g.sh"), to: "sub/g.sh" }], workdir);
    expect(readFileSync(path.join(workdir, "sub/g.sh"), "utf8")).toBe(GRADER);
    expect(m.restore()).toEqual([]);
    expect(existsSync(path.join(workdir, "sub/g.sh"))).toBe(false);
  });

  it("parks a pre-existing destination file and puts it back, with a note", () => {
    writeFileSync(path.join(graderDir, "g.sh"), GRADER);
    writeFileSync(path.join(workdir, "g.sh"), "AGENT FILE");
    const m = materializeHoldouts([{ evaluator: "c", from: path.join(graderDir, "g.sh"), to: "g.sh" }], workdir);
    expect(readFileSync(path.join(workdir, "g.sh"), "utf8")).toBe(GRADER); // author's copy runs
    const notes = m.restore();
    expect(notes.join("\n")).toMatch(/temporarily displaced/);
    expect(readFileSync(path.join(workdir, "g.sh"), "utf8")).toBe("AGENT FILE"); // restored
  });

  it("throws when a copy fails (missing source), leaving nothing behind", () => {
    expect(() =>
      materializeHoldouts([{ evaluator: "c", from: path.join(graderDir, "missing.sh"), to: "g.sh" }], workdir),
    ).toThrow(/could not materialize/);
    expect(existsSync(path.join(workdir, "g.sh"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("engine integration", () => {
  it("baseline runs RED against the materialized grader, agent work turns it green, grader never visible to the agent", async () => {
    writeFileSync(path.join(graderDir, "grader.sh"), GRADER);
    const report = await engine().run(holdoutSpec(), { baseDir: root });

    expect(report.outcome).toBe("success");
    // Baseline saw the real grader (exit 1 = grader logic failed), not a
    // missing-file 127 — proof it was materialized for the baseline pass.
    const baseEval = report.baseline?.evaluations[0];
    expect(report.baseline?.satisfied).toBe(false);
    expect((baseEval?.details as { exitCode?: number })?.exitCode).toBe(1);
    // The mock agent tried to copy the grader during its turn and could not.
    expect(existsSync(path.join(workdir, "leaked.txt"))).toBe(false);
    // The grader is gone once the run ends, and never counted as work.
    expect(existsSync(path.join(workdir, "grader.sh"))).toBe(false);
    expect(report.changedFiles ?? []).not.toContain("grader.sh");
  });

  it("a pre-existing file at the destination is displaced during evaluation, restored after, and surfaced", async () => {
    writeFileSync(path.join(graderDir, "grader.sh"), GRADER);
    writeFileSync(path.join(workdir, "grader.sh"), "STUB");
    const report = await engine().run(holdoutSpec(), { baseDir: root });
    expect(report.outcome).toBe("success");
    expect(report.warnings.join("\n")).toMatch(/temporarily displaced/);
    expect(readFileSync(path.join(workdir, "grader.sh"), "utf8")).toBe("STUB");
  });

  it("editing the holdout SOURCE mid-run is evaluator tampering (error mode fails the green)", async () => {
    writeFileSync(path.join(graderDir, "grader.sh"), GRADER);
    const spec = holdoutSpec();
    // The mock agent escapes the workspace and rewrites the grader source to a
    // vacuous `true`, then writes the answer so checks pass.
    (spec.driver.options as { steps: unknown[] }).steps = [
      { files: { "answer.txt": "42", "../graders/grader.sh": "true\n" } },
    ];
    spec.limits.evaluatorGuard = "error";
    const report = await engine().run(spec, { baseDir: root });
    expect(report.outcome).toBe("evaluator-tampered");
    expect(report.success).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/holdout source/);
  });

  it("a missing holdout source fails the run before any agent spend", async () => {
    const report = await engine().run(holdoutSpec(), { baseDir: root }); // grader never written
    expect(report.outcome).toBe("error");
    expect(report.reason).toMatch(/holdout configuration invalid/);
    expect(report.iterations).toHaveLength(0);
    expect(report.baseline).toBeUndefined();
  });

  it("an escaping holdout destination fails the run before any agent spend", async () => {
    writeFileSync(path.join(graderDir, "grader.sh"), GRADER);
    const spec = holdoutSpec();
    spec.evaluators[0]!.holdout = [{ from: "graders/grader.sh", to: "../graders/pwned.sh" }];
    const report = await engine().run(spec, { baseDir: root });
    expect(report.outcome).toBe("error");
    expect(report.reason).toMatch(/escapes the workspace/);
    expect(report.iterations).toHaveLength(0);
  });

  it("feedback carries only failure text — never the grader body", async () => {
    writeFileSync(path.join(graderDir, "grader.sh"), GRADER);
    const spec = holdoutSpec({ limits: { maxIterations: 1, baseline: false } });
    (spec.driver.options as { steps: unknown[] }).steps = [{ files: { "answer.txt": "wrong" } }];
    const report = await engine().run(spec, { baseDir: root });
    expect(report.outcome).toBe("max-iterations");
    const evalFeedback = report.iterations[0]?.evaluations[0]?.feedback ?? "";
    expect(evalFeedback).not.toContain(GRADER);
  });
});

// ---------------------------------------------------------------------------
describe("lint rules", () => {
  const lintCtx = (spec: ReturnType<typeof parseSpec>, file?: string) =>
    lintSpec(spec, { workdir, ...(file ? { file } : {}) });

  it("flags an escaping destination (error) and a visible source (warn)", () => {
    writeFileSync(path.join(workdir, "visible.sh"), GRADER);
    const spec = parseSpec({
      name: "l",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [
        {
          uses: "command",
          as: "c",
          options: { command: "true" },
          holdout: [
            { from: "app/visible.sh", to: "../out.sh" },
            { from: "app/visible.sh", to: "in.sh" },
          ],
        },
      ],
    });
    const findings = lintCtx(spec, path.join(root, "spec.loop.yaml"));
    expect(findings.some((f) => f.ruleId === "SPEC-HOLDOUT-DEST-ESCAPES" && f.severity === "error")).toBe(true);
    expect(findings.some((f) => f.ruleId === "SPEC-HOLDOUT-SOURCE-VISIBLE" && f.severity === "warn")).toBe(true);
  });

  it("flags a missing source only when the spec file location is known", () => {
    const spec = parseSpec({
      name: "l",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [
        { uses: "command", as: "c", options: { command: "true" }, holdout: [{ from: "graders/nope.sh", to: "g.sh" }] },
      ],
    });
    const withFile = lintCtx(spec, path.join(root, "spec.loop.yaml"));
    expect(withFile.some((f) => f.ruleId === "SPEC-HOLDOUT-SOURCE-MISSING")).toBe(true);
    const inMemory = lintCtx(spec);
    expect(inMemory.some((f) => f.ruleId === "SPEC-HOLDOUT-SOURCE-MISSING")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("self-verification telemetry", () => {
  it("extractCommandText recognizes command-like inputs and nothing else", () => {
    expect(extractCommandText("npm test")).toBe("npm test");
    expect(extractCommandText({ command: "npm test" })).toBe("npm test");
    expect(extractCommandText({ cmd: "npm test" })).toBe("npm test");
    expect(extractCommandText({ script: "npm test" })).toBe("npm test");
    expect(extractCommandText({ commandLine: "npm test" })).toBe("npm test");
    expect(extractCommandText({ args: ["npm", "test"] })).toBe("npm test");
    expect(extractCommandText({ args: ["npm", 1] })).toBeNull();
    expect(extractCommandText({ args: [] })).toBeNull();
    expect(extractCommandText({ file_path: "a.ts", content: "npm test" })).toBeNull(); // file writes never count
    expect(extractCommandText(null)).toBeNull();
    expect(extractCommandText(42)).toBeNull();
  });

  it("counts the agent running a grader command itself; file writes and prose do not count", async () => {
    const registries = createDefaultRegistries();
    registries.drivers.register({
      name: "emitter",
      async run(inv) {
        inv.emit?.({ kind: "model-message", text: "I will run sh check.sh now" }); // prose: not counted
        inv.emit?.({ kind: "tool-call", name: "bash", input: { command: "sh check.sh" } });
        inv.emit?.({ kind: "tool-call", name: "bash", input: { command: "cd sub && sh check.sh --verbose" } });
        inv.emit?.({ kind: "tool-call", name: "write", input: { file_path: "x", content: "sh check.sh" } }); // not counted
        inv.emit?.({ kind: "tool-call", name: "bash", input: { command: "ls" } }); // different command
        writeFileSync(path.join(inv.workdir, "done.txt"), "1");
        return { ok: true, stopReason: "completed" as const, changedFiles: ["done.txt"] };
      },
    });
    const spec = parseSpec({
      name: "telemetry",
      requirements: "x",
      driver: { uses: "emitter" },
      evaluators: [{ uses: "command", as: "check", options: { command: "sh check.sh" } }],
      limits: { maxIterations: 1 },
    });
    writeFileSync(path.join(workdir, "check.sh"), "exit 0\n");
    const report = await new LoopEngine(registries, silentLogger).run(spec, { baseDir: workdir });
    expect(report.iterations[0]?.selfEvalRuns).toEqual({ check: 2 });
  });

  it("stays absent when the driver emits nothing", async () => {
    writeFileSync(path.join(workdir, "check.sh"), "exit 0\n");
    const spec = parseSpec({
      name: "quiet",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: "sh check.sh" } }],
      limits: { maxIterations: 1 },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.iterations[0]?.selfEvalRuns).toBeUndefined();
  });
});
