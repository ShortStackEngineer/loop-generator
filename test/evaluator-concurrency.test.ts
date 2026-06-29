import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine, mapWithConcurrency } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import type { Evaluator } from "../src/evaluators/types";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-eval-conc-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("engine evaluator concurrency", () => {
  let active = 0;
  let maxActive = 0;
  const completion: string[] = [];

  // A probe evaluator that overlaps observably: bump a shared counter, yield for
  // a (per-instance) delay, record the peak and completion order, then release.
  // Mirrors the driver probe in batch.test.ts. `maxActive` reveals how many ran
  // at once; `completion` reveals the order in which they *finished*.
  const probe: Evaluator = {
    type: "command", // override the built-in `command` so specs resolve to this
    async evaluate(ctx) {
      const name = (ctx.options.name as string) ?? "?";
      const delay = (ctx.options.delay as number) ?? 20;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delay));
      completion.push(name);
      active -= 1;
      return { passed: true, feedback: name };
    },
  };

  function probeEngine(): LoopEngine {
    const regs = createDefaultRegistries();
    regs.evaluators.override(probe);
    return new LoopEngine(regs, silentLogger);
  }

  const driver = { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } };
  const evaluators = [
    { uses: "command", as: "first", options: { name: "first", delay: 40 } },
    { uses: "command", as: "second", options: { name: "second", delay: 5 } },
  ];

  beforeEach(() => {
    active = 0;
    maxActive = 0;
    completion.length = 0;
  });

  it("runs evaluators sequentially by default (maxActive === 1)", async () => {
    const spec = parseSpec({
      name: "seq",
      requirements: "x",
      driver,
      evaluators,
      limits: { maxIterations: 1 },
    });
    const report = await probeEngine().run(spec, { baseDir: workdir });
    expect(report.iterations).toHaveLength(1);
    expect(maxActive).toBe(1);
    // Sequential → the longer-delay evaluator still finishes first (input order).
    expect(completion).toEqual(["first", "second"]);
  });

  it("runs them in parallel when evaluation.concurrency allows it (maxActive === 2)", async () => {
    const spec = parseSpec({
      name: "par",
      requirements: "x",
      driver,
      evaluation: { concurrency: 2 },
      evaluators,
      limits: { maxIterations: 1 },
    });
    await probeEngine().run(spec, { baseDir: workdir });
    expect(maxActive).toBe(2);
  });

  it("preserves evaluation order regardless of concurrency", async () => {
    const spec = parseSpec({
      name: "order",
      requirements: "x",
      driver,
      evaluation: { concurrency: 2 },
      evaluators,
      limits: { maxIterations: 1 },
    });
    const report = await probeEngine().run(spec, { baseDir: workdir });
    const names = report.iterations[0]!.evaluations.map((e) => e.name);
    // Results keep input order even though "second" (delay 5) finished before
    // "first" (delay 40) — proving the runner overlapped them yet sorted output.
    expect(names).toEqual(["first", "second"]);
    expect(completion).toEqual(["second", "first"]);
  });
});

// ---------------------------------------------------------------------------
describe("mapWithConcurrency", () => {
  it("preserves input order even when later items resolve first", async () => {
    const out = await mapWithConcurrency([30, 5, 15], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("never exceeds the in-flight limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });

  it("runs sequentially at limit 1", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it("runs fully parallel when the limit meets or exceeds the item count", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("handles an empty list without calling fn", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 1, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
