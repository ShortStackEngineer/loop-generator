import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-engine-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

describe("LoopEngine", () => {
  it("converges: fails iteration 0, passes after the agent fixes it", async () => {
    const spec = parseSpec({
      name: "converge",
      requirements: "write 42 to answer.txt",
      driver: {
        uses: "mock",
        options: {
          steps: [{ files: { "answer.txt": "wrong" } }, { files: { "answer.txt": "42" } }],
        },
      },
      evaluators: [
        { uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } },
      ],
      success: { type: "all-pass" },
      limits: { maxIterations: 5 },
    });

    const report = await engine().run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.iterations).toHaveLength(2); // failed once, then passed
    expect(report.iterations[0]!.satisfied).toBe(false);
    expect(report.iterations[1]!.satisfied).toBe(true);
    expect(readFileSync(path.join(workdir, "answer.txt"), "utf8")).toBe("42");
  });

  it("stops at maxIterations when it never converges", async () => {
    const spec = parseSpec({
      name: "never",
      requirements: "impossible",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "nope" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 3 },
    });

    const report = await engine().run(spec, { baseDir: workdir });

    expect(report.success).toBe(false);
    expect(report.outcome).toBe("max-iterations");
    expect(report.iterations).toHaveLength(3);
  });

  it("fails fast on an unknown driver", async () => {
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "does-not-exist" },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(false);
    expect(report.reason).toContain("Unknown driver");
  });

  it("honors a score-based success criterion via the experiment evaluator", async () => {
    const spec = parseSpec({
      name: "metric",
      requirements: "emit a good metric",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "metrics.json": JSON.stringify({ value: 0.9 }) } }] },
      },
      evaluators: [
        { uses: "experiment", as: "metric", options: { metricsFile: "metrics.json", metric: "value", minValue: 0.5 } },
      ],
      success: { type: "score", evaluator: "metric", gte: 0.8 },
      limits: { maxIterations: 2 },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(report.iterations[0]!.evaluations[0]!.score).toBe(0.9);
  });
});
