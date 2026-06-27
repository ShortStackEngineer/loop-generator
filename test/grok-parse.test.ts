import { describe, it, expect } from "vitest";
import { parseJsonObjects, extractFinalText, cleanSummary } from "../src/drivers/grok";

describe("grok output parsing", () => {
  it("extracts the final result event from JSONL, not the reasoning stream", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", role: "assistant", content: [{ text: "let me think about this..." }] }),
      JSON.stringify({ type: "assistant", role: "assistant", content: [{ text: "editing files..." }] }),
      JSON.stringify({
        type: "result",
        result: "Implemented the chatbot slice; 12 tests pass.",
        usage: { input_tokens: 100, output_tokens: 50, turns: 12 },
        total_cost_usd: 0.42,
        session_id: "abc-123",
      }),
    ].join("\n");

    const objs = parseJsonObjects(stdout);
    expect(extractFinalText(objs)).toBe("Implemented the chatbot slice; 12 tests pass.");
  });

  it("falls back to an assistant content array when there is no result event", () => {
    const stdout = JSON.stringify({ role: "assistant", content: [{ text: "Done." }] });
    expect(extractFinalText(parseJsonObjects(stdout))).toBe("Done.");
  });

  it("returns nothing parseable for a raw reasoning dump (the old garbage case)", () => {
    // This is the kind of output that previously got sliced into a mangled summary.
    const dump = "ne, now improve the UI view significantly.\nGood. Note in view...\nonly chat tests? Why?";
    const objs = parseJsonObjects(dump);
    expect(objs).toEqual([]);
    expect(extractFinalText(objs)).toBeUndefined();
  });

  it("collapses whitespace and caps length", () => {
    const messy = `first line\n\n   second\twith   spaces ${"x".repeat(400)}`;
    const s = cleanSummary(messy, 50);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s).not.toContain("\n");
    expect(s.endsWith("…")).toBe(true);
  });
});
