import { describe, it, expect } from "vitest";
import { parseSpec, SpecValidationError } from "../src/core/spec";

describe("parseSpec", () => {
  it("fills defaults for a minimal spec", () => {
    const spec = parseSpec({
      name: "demo",
      requirements: "do the thing",
      driver: { uses: "mock" },
    });
    expect(spec.version).toBe(1);
    expect(spec.task.type).toBe("function");
    expect(spec.workspace.dir).toBe(".");
    expect(spec.workspace.snapshot).toBe("none");
    expect(spec.success).toEqual({ type: "all-pass" });
    expect(spec.limits.maxIterations).toBe(5);
    expect(spec.evaluators).toEqual([]);
  });

  it("aliases evaluators and defaults their options", () => {
    const spec = parseSpec({
      name: "demo",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "tests", options: { command: "npm test" } }],
    });
    expect(spec.evaluators[0]).toEqual({
      uses: "command",
      as: "tests",
      options: { command: "npm test" },
    });
  });

  it("parses nested success criteria", () => {
    const spec = parseSpec({
      name: "demo",
      requirements: "x",
      driver: { uses: "mock" },
      success: {
        type: "all",
        of: [{ type: "pass", evaluators: ["tests"] }, { type: "score", evaluator: "metric", gte: 0.1 }],
      },
    });
    expect(spec.success.type).toBe("all");
  });

  it("throws a SpecValidationError with field paths", () => {
    try {
      parseSpec({ requirements: "x", driver: { uses: "mock" } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecValidationError);
      expect((err as SpecValidationError).message).toContain("name");
    }
  });
});
