import { describe, it, expect } from "vitest";
import { parseSpec } from "../src/core/spec";
import { applyDriverOverride, validateDriverName } from "../src/core/driver-override";
import { unknownOptionKeys, unknownOptionWarnings } from "../src/drivers/options";

describe("applyDriverOverride", () => {
  it("swaps uses while preserving options", () => {
    const spec = parseSpec({
      name: "x",
      requirements: "y",
      driver: { uses: "github-copilot", options: { allowAllTools: true, model: "gpt-5" } },
    });
    const next = applyDriverOverride(spec, "claude-agent-sdk");
    expect(next.driver.uses).toBe("claude-agent-sdk");
    expect(next.driver.options).toEqual({ allowAllTools: true, model: "gpt-5" });
    // Original untouched
    expect(spec.driver.uses).toBe("github-copilot");
  });

  it("rejects empty names", () => {
    const spec = parseSpec({ name: "x", requirements: "y", driver: { uses: "mock" } });
    expect(() => applyDriverOverride(spec, "  ")).toThrow(/non-empty/);
  });
});

describe("validateDriverName", () => {
  it("accepts registered names", () => {
    expect(validateDriverName("mock", ["mock", "grok"])).toBeNull();
  });
  it("lists available drivers on failure", () => {
    expect(validateDriverName("nope", ["mock", "grok"])).toMatch(/Available: mock, grok/);
  });
});

describe("unknownOptionKeys / warnings", () => {
  it("lists keys not in the known set", () => {
    expect(unknownOptionKeys({ model: "x", allowAllTools: true }, ["model", "maxTurns"])).toEqual([
      "allowAllTools",
    ]);
  });
  it("formats a preflight warning", () => {
    const w = unknownOptionWarnings("claude-agent-sdk", { allowAllTools: true }, ["model"]);
    expect(w[0]).toMatch(/allowAllTools/);
    expect(w[0]).toMatch(/switch drivers/);
  });
  it("returns nothing when options are clean", () => {
    expect(unknownOptionWarnings("mock", { steps: [] }, ["steps", "defaultSummary"])).toEqual([]);
  });
});
