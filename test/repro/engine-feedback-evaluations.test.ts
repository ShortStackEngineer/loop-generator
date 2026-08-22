/**
 * Repro: LoopEngine must pass prior evaluator results on invocation.feedback.evaluations
 * (structured channel), not only embed prose in the iteration prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../../src/core/engine";
import { parseSpec } from "../../src/core/spec";
import { createDefaultRegistries } from "../../src/registry";
import { silentLogger } from "../../src/core/logger";
import type { AgentDriver, AgentInvocation } from "../../src/drivers/types";

describe("engine structured feedback channel", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "loopgen-repro-fb-"));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("passes prior evaluator results on invocation.feedback.evaluations on iteration 2", async () => {
    const invocations: AgentInvocation[] = [];
    const capturing: AgentDriver = {
      name: "capture-feedback",
      async run(inv) {
        invocations.push(inv);
        writeFileSync(
          path.join(inv.workdir, "answer.txt"),
          inv.iteration === 0 ? "wrong" : "42",
        );
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };

    const regs = createDefaultRegistries();
    regs.drivers.override(capturing);

    const spec = parseSpec({
      name: "engine-feedback-evaluations",
      requirements: "Write 42 to answer.txt",
      driver: { uses: "capture-feedback" },
      evaluators: [
        {
          uses: "command",
          as: "gate",
          options: { command: `test "$(cat answer.txt)" = "42"` },
        },
      ],
      limits: { maxIterations: 3 },
    });

    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.success).toBe(true);
    expect(invocations.length).toBeGreaterThanOrEqual(2);

    const second = invocations[1]!;
    expect(second.feedback).toBeDefined();
    expect(second.feedback!.passed).toBe(false);
    expect(second.feedback!.evaluations.length).toBeGreaterThan(0);
    expect(second.feedback!.evaluations[0]).toMatchObject({
      name: "gate",
      type: "command",
      passed: false,
    });
    expect(second.feedback!.evaluations[0]!.feedback.length).toBeGreaterThan(0);
  });
});
