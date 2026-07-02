import { describe, it, expect } from "vitest";
import { shortAgent } from "../src/cli/run";
import type { IterationReport } from "../src/core/engine";
import type { AgentUsage } from "../src/drivers/types";

function iter(usage: AgentUsage | undefined, over: Partial<IterationReport["agent"]> = {}): IterationReport {
  return {
    iteration: 0,
    agent: { ok: true, stopReason: "completed", usage, ...over },
    evaluations: [],
    satisfied: false,
    reason: "",
    durationMs: 0,
    warnings: [],
  };
}

describe("shortAgent CLI line (roadmap #5)", () => {
  it("surfaces per-iteration input/output tokens alongside turns and cost", () => {
    const line = shortAgent(iter({ inputTokens: 1200, outputTokens: 340, turns: 3, costUsd: 0.02 }));
    expect(line).toContain("1200 in / 340 out tok");
    expect(line).toContain("3t");
    expect(line).toContain("$0.02");
  });

  it("still shows the token segment when only one of in/out is present", () => {
    expect(shortAgent(iter({ outputTokens: 50 }))).toContain("0 in / 50 out tok");
  });

  it("omits the token segment entirely when no usage is reported", () => {
    const line = shortAgent(iter(undefined));
    expect(line).toBe("agent ok");
    expect(line).not.toContain("tok");
  });

  it("keeps the failure marker for a failed driver run", () => {
    const line = shortAgent(iter({ inputTokens: 5, outputTokens: 5 }, { ok: false, stopReason: "error" }));
    expect(line).toContain("agent ✗ error");
    expect(line).toContain("5 in / 5 out tok");
  });
});
