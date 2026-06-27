import { describe, it, expect } from "vitest";
import { languageCommands, standardEvaluators, createTaskType } from "../src/tasks/base";
import { functionTask, apiTask, webappTask, experimentTask, genericTask, builtinTaskTypes } from "../src/tasks/builtin";
import { generateSpec, specToYaml } from "../src/generate";
import { parseSpec, type LoopSpec } from "../src/core/spec";
import type { FeedbackSummary } from "../src/drivers/types";

function specWith(over: Partial<LoopSpec> = {}): LoopSpec {
  return parseSpec({
    name: "t",
    requirements: "Do the thing.",
    driver: { uses: "mock" },
    stack: { language: "typescript" },
    ...over,
  });
}

describe("languageCommands", () => {
  it("maps known languages and falls back for unknown", () => {
    expect(languageCommands("typescript").test).toBe("npm test");
    expect(languageCommands("python").check).toContain("ruff");
    expect(languageCommands("rust").test).toBe("cargo test");
    expect(languageCommands("cobol").test).toMatch(/configure your test command/);
    expect(languageCommands(undefined).test).toMatch(/configure/);
  });
});

describe("standardEvaluators", () => {
  it("includes tests and a static check when the language has one", () => {
    const evals = standardEvaluators(specWith({ stack: { language: "typescript" } }));
    expect(evals.map((e) => e.as)).toContain("tests");
    expect(evals.map((e) => e.as)).toContain("static-check");
  });
  it("omits the static check when the language has none", () => {
    const evals = standardEvaluators(specWith({ stack: { language: "java" } }));
    expect(evals.map((e) => e.as)).toEqual(["tests"]);
  });
});

describe("built-in task types", () => {
  const feedback: FeedbackSummary = { passed: false, reason: "r", text: "FEEDBACK_BODY", evaluations: [] };

  for (const t of [functionTask, apiTask, webappTask, experimentTask, genericTask]) {
    it(`${t.type} builds all three prompts`, () => {
      const spec = specWith({ task: { type: t.type } });
      const sys = t.buildSystemPrompt(spec);
      const init = t.buildInitialPrompt(spec);
      const iter = t.buildIterationPrompt(spec, feedback);
      expect(sys).toContain("automated feedback loop");
      expect(init).toContain("Do the thing.");
      expect(init).toContain("Success is measured by");
      expect(iter).toContain("FEEDBACK_BODY");
    });
  }

  it("webapp recommends a build check; experiment recommends a metric check", () => {
    const spec = specWith();
    expect(webappTask.recommendedEvaluators(spec).map((e) => e.as)).toContain("build");
    expect(experimentTask.recommendedEvaluators(spec).map((e) => e.as)).toContain("metric");
  });

  it("registers exactly the five built-ins", () => {
    expect(builtinTaskTypes.map((t) => t.type).sort()).toEqual(["api", "experiment", "function", "generic", "webapp"]);
  });

  it("initial prompt notes when no checks are configured", () => {
    const spec = specWith({ evaluators: [] });
    expect(functionTask.buildInitialPrompt(spec)).toMatch(/no automated checks/i);
  });

  it("respects a custom iteration prompt override", () => {
    const spec = specWith({ prompts: { iteration: "CUSTOM_PREFIX" } });
    const out = functionTask.buildIterationPrompt(spec, feedback);
    expect(out).toContain("CUSTOM_PREFIX");
    expect(out).toContain("FEEDBACK_BODY");
  });
});

describe("createTaskType validate passthrough", () => {
  it("surfaces a custom validate hook", () => {
    const t = createTaskType({
      type: "x",
      description: "d",
      role: "r",
      guidance: ["g"],
      recommendedEvaluators: () => [],
      validate: () => ["bad"],
    });
    expect(t.validate?.(specWith())).toEqual(["bad"]);
  });
});

describe("generateSpec", () => {
  it("produces a valid spec with recommended evaluators", () => {
    const spec = generateSpec({
      name: "Sum",
      taskType: "function",
      language: "typescript",
      requirements: "add(a,b)",
    });
    expect(spec.name).toBe("Sum");
    expect(spec.driver.uses).toBe("claude-agent-sdk");
    expect(spec.evaluators.map((e) => e.as)).toContain("tests");
  });

  it("falls back to the generic task for an unknown type and honors overrides", () => {
    const spec = generateSpec({
      name: "Custom",
      taskType: "totally-unknown",
      language: "go",
      requirements: "x",
      driver: "mock",
      evaluators: [{ uses: "command", as: "only", options: { command: "true" } }],
      success: { type: "pass", evaluators: ["only"] },
      maxIterations: 9,
    });
    expect(spec.driver.uses).toBe("mock");
    expect(spec.evaluators).toHaveLength(1);
    expect(spec.limits.maxIterations).toBe(9);
  });

  it("serializes to YAML with a header", () => {
    const yaml = specToYaml(generateSpec({ name: "Y", taskType: "function", language: "typescript", requirements: "x" }));
    expect(yaml).toContain("loop-generator spec");
    expect(yaml).toContain("name: Y");
  });
});
