import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseBatchManifest, BatchValidationError, type BatchManifest } from "../src/batch/manifest";
import { runBatch } from "../src/batch/runner";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { silentLogger } from "../src/core/logger";
import type { AgentDriver } from "../src/drivers/types";

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "loopgen-batch-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const engine = (regs = createDefaultRegistries()) => new LoopEngine(regs, silentLogger);

/** An inline mock-driven item: writes a file, checks it (pass) or `exit 1` (fail). */
function item(name: string, opts: { pass?: boolean; needs?: string[]; ws?: string } = {}) {
  const pass = opts.pass ?? true;
  return {
    name,
    needs: opts.needs,
    inline: {
      name: `${name}-spec`,
      requirements: "do it",
      workspace: { dir: opts.ws ?? "." },
      driver: { uses: "mock", options: { steps: [{ files: { [`${name}.txt`]: "ok" } }] } },
      evaluators: [{ uses: "command", as: "c", options: { command: pass ? "true" : "exit 1" } }],
      limits: { maxIterations: 1 },
    },
  };
}

const manifest = (over: Record<string, unknown>): BatchManifest => parseBatchManifest({ items: [], ...over });

describe("batch manifest validation", () => {
  it("rejects duplicate names, unknown/self needs, and cycles", () => {
    expect(() => parseBatchManifest({ items: [item("a"), item("a")] })).toThrow(BatchValidationError);
    expect(() => parseBatchManifest({ items: [item("a", { needs: ["ghost"] })] })).toThrow(/unknown item/);
    expect(() => parseBatchManifest({ items: [item("a", { needs: ["a"] })] })).toThrow(/cannot depend on itself/);
    expect(() =>
      parseBatchManifest({ items: [item("a", { needs: ["b"] }), item("b", { needs: ["a"] })] }),
    ).toThrow(/cycle/);
  });

  it("requires exactly one of spec or inline", () => {
    expect(() => parseBatchManifest({ items: [{ name: "a" }] })).toThrow(/exactly one/);
    expect(() =>
      parseBatchManifest({ items: [{ name: "a", spec: "x.yaml", inline: item("a").inline }] }),
    ).toThrow(/exactly one/);
  });
});

describe("batch scheduling", () => {
  it("runs multiple items and aggregates results", async () => {
    const report = await runBatch(manifest({ name: "punch", items: [item("a"), item("b")] }), engine(), { baseDir: dir, log: silentLogger });
    expect(report.success).toBe(true);
    expect(report.counts).toMatchObject({ success: 2, failed: 0, skipped: 0, error: 0, total: 2 });
  });

  it("continues past a failure by default", async () => {
    const report = await runBatch(
      manifest({ items: [item("a", { pass: false, ws: "wa" }), item("b", { ws: "wb" })] }),
      engine(),
      { baseDir: dir, log: silentLogger },
    );
    expect(report.success).toBe(false);
    expect(report.counts).toMatchObject({ success: 1, failed: 1 });
    expect(report.items.find((r) => r.name === "b")!.status).toBe("success");
  });

  it("stops scheduling new items after a failure when continueOnError=false", async () => {
    const report = await runBatch(manifest({ items: [item("a", { pass: false }), item("b")] }), engine(), {
      baseDir: dir, log: silentLogger,
      continueOnError: false,
    });
    const b = report.items.find((r) => r.name === "b")!;
    expect(b.status).toBe("skipped");
    expect(b.reason).toMatch(/batch stopped/);
  });

  it("respects needs ordering and skips dependents of a failed item", async () => {
    const report = await runBatch(
      manifest({ items: [item("a", { pass: false }), item("b", { needs: ["a"] })] }),
      engine(),
      { baseDir: dir, log: silentLogger },
    );
    const b = report.items.find((r) => r.name === "b")!;
    expect(b.status).toBe("skipped");
    expect(b.reason).toMatch(/dependency "a"/);
  });

  it("runs a dependent after its dependency succeeds", async () => {
    const report = await runBatch(
      manifest({ items: [item("a"), item("b", { needs: ["a"] })] }),
      engine(),
      { baseDir: dir, log: silentLogger },
    );
    expect(report.success).toBe(true);
    expect(report.items.map((r) => r.status)).toEqual(["success", "success"]);
  });

  it("reports an error when a spec file is missing", async () => {
    const m = manifest({ items: [{ name: "missing", spec: "nope.loop.yaml" }] });
    const report = await runBatch(m, engine(), { baseDir: dir, log: silentLogger });
    expect(report.items[0]!.status).toBe("error");
    expect(report.counts.error).toBe(1);
  });

  it("cascades a resolve error to dependents even when the dependent is listed first", async () => {
    // Dependent before its (missing-spec) dependency: exercises the order-sensitive
    // bug where the dependent would otherwise be labeled "not scheduled".
    const m = manifest({
      items: [item("b", { needs: ["broken"] }), { name: "broken", spec: "nope.loop.yaml" }],
    });
    const report = await runBatch(m, engine(), { baseDir: dir, log: silentLogger });
    expect(report.items.find((r) => r.name === "broken")!.status).toBe("error");
    const b = report.items.find((r) => r.name === "b")!;
    expect(b.status).toBe("skipped");
    expect(b.reason).toMatch(/dependency "broken"/);
  });

  it("applies a maxIterations override to all items without mutating the spec", async () => {
    const failing = {
      name: "never",
      inline: {
        name: "never",
        requirements: "x",
        workspace: { dir: "." },
        driver: { uses: "mock", options: { steps: [{ files: { "a.txt": "1" } }] } },
        evaluators: [{ uses: "command", as: "c", options: { command: "exit 1" } }],
        limits: { maxIterations: 9 },
      },
    };
    const m = manifest({ items: [failing] });
    const report = await runBatch(m, engine(), { baseDir: dir, log: silentLogger, maxIterations: 2 });
    expect(report.items[0]!.report!.iterations).toHaveLength(2); // override (2) wins over spec (9)
    // Spec object was not mutated by the override.
    expect(m.items[0]!.inline!.limits.maxIterations).toBe(9);
  });

  it("loads an item from a spec file on disk", async () => {
    writeFileSync(
      path.join(dir, "task.loop.yaml"),
      "name: from-file\nrequirements: x\ndriver: { uses: mock, options: { steps: [{ files: { f.txt: ok } }] } }\nevaluators: [{ uses: command, as: c, options: { command: 'true' } }]\nlimits: { maxIterations: 1 }\n",
    );
    const report = await runBatch(manifest({ items: [{ name: "f", spec: "task.loop.yaml" }] }), engine(), {
      baseDir: dir, log: silentLogger,
    });
    expect(report.success).toBe(true);
  });
});

describe("batch concurrency + workspace exclusivity", () => {
  let active = 0;
  let maxActive = 0;
  const probe: AgentDriver = {
    name: "probe",
    async run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return { ok: true, stopReason: "completed", changedFiles: ["x"] };
    },
  };

  function probeItem(name: string, ws: string) {
    return {
      name,
      inline: {
        name: `${name}-spec`,
        requirements: "x",
        workspace: { dir: ws },
        driver: { uses: "probe" },
        evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
        limits: { maxIterations: 1 },
      },
    };
  }

  function probeEngine() {
    const regs = createDefaultRegistries();
    regs.drivers.override(probe);
    return new LoopEngine(regs, silentLogger);
  }

  beforeEach(() => {
    active = 0;
    maxActive = 0;
  });

  it("runs distinct-workspace items in parallel at the concurrency limit", async () => {
    const report = await runBatch(
      manifest({ concurrency: 2, items: [probeItem("a", "wa"), probeItem("b", "wb")] }),
      probeEngine(),
      { baseDir: dir, log: silentLogger },
    );
    expect(report.success).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("serializes items that share a workspace even at concurrency 2", async () => {
    const report = await runBatch(
      manifest({ concurrency: 2, items: [probeItem("a", "same"), probeItem("b", "same")] }),
      probeEngine(),
      { baseDir: dir, log: silentLogger },
    );
    expect(report.success).toBe(true);
    expect(maxActive).toBe(1); // same workspace → never overlap
  });
});
