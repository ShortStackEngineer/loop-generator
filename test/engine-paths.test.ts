import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { createTaskType } from "../src/tasks/base";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-paths-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

const engine = () => new LoopEngine(createDefaultRegistries(), silentLogger);

describe("engine resolution + preflight paths", () => {
  it("fails fast on an unknown evaluator", async () => {
    const spec = parseSpec({
      name: "x",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [{ uses: "ghost", options: {} }],
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(false);
    expect(report.reason).toMatch(/Unknown evaluator/);
  });

  it("returns preflight-failed when an evaluator's preflight rejects", async () => {
    const spec = parseSpec({
      name: "x",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
      // command evaluator preflight fails without a `command`
      evaluators: [{ uses: "command", as: "bad", options: {} }],
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("preflight-failed");
    expect(report.preflight?.ok).toBe(false);
  });

  it("skipPreflight bypasses preflight (evaluator then errors at run time)", async () => {
    const spec = parseSpec({
      name: "x",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "bad", options: {} }],
      limits: { maxIterations: 1 },
    });
    const report = await engine().run(spec, { baseDir: workdir, skipPreflight: true });
    // It runs, but the evaluator throws on parse → ok:false, never satisfied.
    expect(report.outcome).toBe("max-iterations");
    expect(report.iterations[0]!.evaluations[0]!.ok).toBe(false);
  });

  it("reports task validation errors", async () => {
    const regs = createDefaultRegistries();
    regs.tasks.register(
      createTaskType({
        type: "strict",
        description: "d",
        role: "r",
        guidance: [],
        recommendedEvaluators: () => [],
        validate: () => ["missing required field"],
      }),
    );
    const spec = parseSpec({
      name: "x",
      requirements: "x",
      task: { type: "strict" },
      driver: { uses: "mock" },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.success).toBe(false);
    expect(report.reason).toMatch(/task validation failed/);
  });

  it("preflight blocks a project-expecting spec pointed at a non-project workdir", async () => {
    const spec = parseSpec({
      name: "misrouted",
      requirements: "x",
      stack: { language: "ruby", framework: "rails" },
      driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
      // bin/rails is a project-local binstub → spec expects an existing project,
      // but the tmp workdir has no Gemfile and isn't a repo.
      evaluators: [{ uses: "command", as: "tests", options: { command: "bin/rails test" } }],
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("preflight-failed");
    expect(report.reason).toMatch(/SPEC-WORKDIR-NOT-PROJECT/);
  });

  it("aborts immediately when the run signal is already aborted", async () => {
    const spec = parseSpec({
      name: "x",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
    });
    const report = await engine().run(spec, { baseDir: workdir, signal: AbortSignal.abort() });
    expect(report.outcome).toBe("aborted");
  });
});
