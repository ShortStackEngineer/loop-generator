import { describe, it, expect } from "vitest";
import { runDriverConformance, scriptedMockOptionsFor } from "../src/testing/conformance";
import { mockDriver } from "../src/drivers/mock";

describe("driver conformance harness", () => {
  it("the mock (reference) driver passes every conformance scenario", async () => {
    const report = await runDriverConformance({
      makeDriver: () => mockDriver,
      // The mock is scripted, so map each scenario's goal to file-writing steps.
      optionsFor: (scenario, token) => scriptedMockOptionsFor(scenario, token),
    });

    expect(report.driver).toBe("mock");
    expect(report.passed).toBe(true);
    for (const check of report.checks) {
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    }
  });

  it("catches a broken driver (no-op that never writes files)", async () => {
    const brokenDriver = {
      name: "broken",
      async run() {
        return { ok: true, summary: "did nothing" };
      },
    };
    const report = await runDriverConformance({ makeDriver: () => brokenDriver });
    expect(report.passed).toBe(false);
    const createsFile = report.checks.find((c) => c.name === "creates-file");
    expect(createsFile?.passed).toBe(false);
  });
});
