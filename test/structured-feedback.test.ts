import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STRUCTURED_FEEDBACK_MARKER,
  augmentPromptWithStructuredFeedback,
  applyStructuredFileFixes,
  structuredFeedbackPayload,
} from "../src/drivers/structured-feedback";
import type { FeedbackSummary } from "../src/drivers/types";

describe("structured feedback", () => {
  it("leaves the prompt unchanged when evaluations are empty", () => {
    const feedback: FeedbackSummary = { passed: false, reason: "nope", text: "x", evaluations: [] };
    expect(augmentPromptWithStructuredFeedback("base", feedback)).toBe("base");
    expect(augmentPromptWithStructuredFeedback("base", undefined)).toBe("base");
  });

  it("appends a JSON block built from evaluations", () => {
    const feedback: FeedbackSummary = {
      passed: false,
      reason: "tests failed",
      text: "prose",
      evaluations: [
        {
          name: "unit",
          type: "command",
          passed: false,
          ok: true,
          feedback: "assertion failed",
          durationMs: 1,
        },
      ],
    };
    const out = augmentPromptWithStructuredFeedback("do work", feedback);
    expect(out).toContain(STRUCTURED_FEEDBACK_MARKER);
    expect(out).toContain('"name": "unit"');
    expect(structuredFeedbackPayload(feedback).evaluations[0]!.feedback).toBe("assertion failed");
  });

  it("applies details.files from failing evaluations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loopgen-struct-"));
    try {
      const result = applyStructuredFileFixes(
        [
          {
            name: "contents",
            type: "command",
            passed: false,
            ok: true,
            feedback: "wrong",
            details: { files: { "OUT.txt": "TOKEN" } },
            durationMs: 0,
          },
        ],
        dir,
      );
      expect(result.applied).toBe(true);
      expect(readFileSync(path.join(dir, "OUT.txt"), "utf8")).toBe("TOKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
