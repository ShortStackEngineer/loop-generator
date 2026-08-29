/**
 * In-repo e2e: LoopEngine + mock `useStructuredFeedback` converges when a
 * failing evaluator attaches `details.files` on `feedback.evaluations`.
 *
 * See `loops/instances/mock-structured-feedback-e2e.loop.yaml`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../../src/core/engine";
import { parseSpec } from "../../src/core/spec";
import { createDefaultRegistries } from "../../src/registry";
import { silentLogger } from "../../src/core/logger";
import type { Evaluator } from "../../src/evaluators/types";

describe("mock structured feedback e2e (in-repo repro)", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "loopgen-mock-sf-e2e-"));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("mock driver fixes answer.txt from feedback.evaluations details.files via LoopEngine", async () => {
    const structuredGate: Evaluator = {
      type: "structured-gate",
      description: "Fails until answer.txt is 42; returns details.files on failure",
      async evaluate(ctx) {
        let contents = "";
        try {
          contents = readFileSync(path.join(ctx.workdir, "answer.txt"), "utf8").trim();
        } catch {
          contents = "";
        }
        if (contents === "42") {
          return { passed: true, feedback: "answer.txt is 42" };
        }
        return {
          passed: false,
          feedback: `answer.txt is ${JSON.stringify(contents)}; expected "42"`,
          details: { files: { "answer.txt": "42" } },
        };
      },
    };

    const regs = createDefaultRegistries();
    regs.evaluators.register(structuredGate);

    const spec = parseSpec({
      name: "mock-structured-feedback-e2e",
      requirements: "Write 42 to answer.txt using structured feedback",
      driver: {
        uses: "mock",
        options: {
          useStructuredFeedback: true,
          // Single step only — iteration 1+ must apply structured fixes, not a
          // second scripted write of "42".
          steps: [{ files: { "answer.txt": "wrong" }, summary: "first attempt" }],
        },
      },
      evaluators: [{ uses: "structured-gate", as: "gate" }],
      limits: { maxIterations: 3 },
    });

    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });

    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.iterations.length).toBe(2);
    expect(readFileSync(path.join(workdir, "answer.txt"), "utf8")).toBe("42");

    // Iteration 0 wrote "wrong" via the scripted step; iteration 1 applied
    // structured feedback (summary from mock driver).
    expect(report.iterations[0]!.agent.summary).toMatch(/first attempt/);
    expect(report.iterations[1]!.agent.summary).toMatch(/structured feedback/);
  });
});
