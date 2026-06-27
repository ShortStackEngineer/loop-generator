import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockDriver } from "../src/drivers/mock";
import { silentLogger } from "../src/core/logger";
import { runDriverConformance, formatConformanceReport } from "../src/testing/conformance";
import type { AgentDriver, AgentInvocation } from "../src/drivers/types";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-mock-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function inv(options: Record<string, unknown>, iteration = 0): AgentInvocation {
  return { runId: "r", iteration, workdir, prompt: "p", options, log: silentLogger };
}

describe("mock driver", () => {
  it("reports a no-op when no steps are configured", async () => {
    const r = await mockDriver.run(inv({}));
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toEqual([]);
    expect(r.summary).toMatch(/no steps/);
  });

  it("writes, deletes, and runs per step", async () => {
    writeFileSync(path.join(workdir, "old.txt"), "x");
    const r = await mockDriver.run(
      inv({
        steps: [
          {
            files: { "new.txt": "hi" },
            deleteFiles: ["old.txt"],
            run: "echo ran > ran.txt",
            summary: "did stuff",
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toContain("new.txt");
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
    expect(existsSync(path.join(workdir, "old.txt"))).toBe(false);
    expect(existsSync(path.join(workdir, "ran.txt"))).toBe(true);
  });

  it("clamps to the last step on later iterations", async () => {
    const options = { steps: [{ files: { "a.txt": "0" } }, { files: { "a.txt": "1" } }] };
    const r = await mockDriver.run(inv(options, 5));
    expect(r.ok).toBe(true);
    expect(r.changedFiles).toContain("a.txt");
  });

  it("returns ok:false when a write fails", async () => {
    mkdirSync(path.join(workdir, "dir-not-file"));
    const r = await mockDriver.run(inv({ steps: [{ files: { "dir-not-file": "boom" } }] }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
  });

  it("falls back to defaultSummary when a step has none", async () => {
    const r = await mockDriver.run(inv({ steps: [{ files: { "a.txt": "x" } }], defaultSummary: "FALLBACK" }));
    expect(r.summary).toBe("FALLBACK");
  });
});

describe("conformance harness (prompt-driven driver)", () => {
  // A prompt-driven driver: acts on the prompt (no optionsFor mapping) and
  // throws on an aborted signal (so honors-abort is honored, not just ignored).
  const promptDriver: AgentDriver = {
    name: "prompt-good",
    async run(invocation) {
      if (invocation.signal?.aborted) throw new Error("aborted");
      const m = invocation.prompt.match(/exactly: (\S+)/);
      if (m) writeFileSync(path.join(invocation.workdir, "OUTPUT.txt"), m[1]!);
      return { ok: true, stopReason: "completed" };
    },
  };

  it("passes a well-behaved prompt-driven driver and honors abort", async () => {
    const report = await runDriverConformance({ makeDriver: () => promptDriver });
    expect(report.passed).toBe(true);
    const abort = report.checks.find((c) => c.name === "honors-abort")!;
    expect(abort.passed).toBe(true);
    expect(abort.warning).toBeFalsy(); // it threw → honored, not merely ignored
  });

  it("supports skipping scenarios", async () => {
    const report = await runDriverConformance({
      makeDriver: () => promptDriver,
      skip: ["applies-feedback"],
    });
    const skipped = report.checks.find((c) => c.name === "applies-feedback")!;
    expect(skipped.detail).toBe("skipped");
  });

  it("formats a report", async () => {
    const report = await runDriverConformance({ makeDriver: () => promptDriver });
    const text = formatConformanceReport(report);
    expect(text).toContain("prompt-good");
    expect(text).toMatch(/PASS|FAIL/);
  });

  it("fails a no-op driver and pinpoints the broken checks", async () => {
    const noop: AgentDriver = { name: "noop", async run() { return { ok: true }; } };
    const report = await runDriverConformance({ makeDriver: () => noop });
    expect(report.passed).toBe(false);
    const created = report.checks.find((c) => c.name === "creates-file")!;
    expect(created.passed).toBe(false);
    expect(created.detail).toMatch(/not created/);
    expect(formatConformanceReport(report)).toContain("FAIL");
  });

  it("fails a driver with no name", async () => {
    const nameless: AgentDriver = { name: "", async run() { return { ok: true }; } };
    const report = await runDriverConformance({ makeDriver: () => nameless });
    const nameCheck = report.checks.find((c) => c.name === "reports-name")!;
    expect(nameCheck.passed).toBe(false);
  });
});
