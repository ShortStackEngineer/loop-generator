/**
 * Dog-food repro: LoopEngine + mock useStructuredFeedback must converge when
 * a failing evaluator attaches details.files on feedback.evaluations.
 *
 * RED until implemented (see loops/instances/mock-structured-feedback-e2e.loop.yaml).
 */
import { describe, it } from "vitest";

describe("mock structured feedback e2e (dog-food repro)", () => {
  it("mock driver fixes answer.txt from feedback.evaluations details.files via LoopEngine", () => {
    // Intentionally failing until the loop delivers the integration test body.
    expect(false, "implement test/repro/mock-structured-feedback-e2e.test.ts").toBe(true);
  });
});
