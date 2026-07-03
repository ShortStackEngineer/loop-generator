import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { createTraceRecorder, runWithTrace, arraySink, jsonlFileSink } from "../src/observability/recorder";
import type { AgentDriver } from "../src/drivers/types";
import type { TraceRecord } from "../src/observability/types";

// A driver that emits a couple of inner-trajectory events and makes a change.
const emitter: AgentDriver = {
  name: "emitter",
  async run(inv) {
    inv.emit?.({ kind: "model-message", text: "hi", turn: 1 });
    inv.emit?.({ kind: "tool-call", name: "Write", id: "t1" });
    writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
    return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
  },
};

function makeSpec(driver: string) {
  return parseSpec({
    name: "trace-me",
    requirements: "write 42",
    driver: { uses: driver },
    evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
    success: { type: "all-pass" },
    limits: { maxIterations: 1, baseline: false },
  });
}

function engineWith(driver: AgentDriver): LoopEngine {
  const regs = createDefaultRegistries();
  regs.drivers.register(driver);
  return new LoopEngine(regs, silentLogger);
}

const signals = (recs: TraceRecord[]) => recs.filter((r): r is Extract<TraceRecord, { kind: "signal" }> => r.kind === "signal");

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-trace-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

describe("trace recorder", () => {
  it("records an ordered run/agent-event/iteration/run stream and preserves caller callbacks", async () => {
    const { records, sink } = arraySink();
    const userIterations: number[] = [];
    const report = await runWithTrace(
      engineWith(emitter),
      makeSpec("emitter"),
      { baseDir: workdir, skipPreflight: true, onIteration: (it) => userIterations.push(it.iteration) },
      sink,
      { now: () => 1000, traceId: "T" },
    );

    expect(report.success).toBe(true);
    // The caller's own onIteration still fired (chained, not clobbered).
    expect(userIterations).toEqual([0]);

    const kinds = records.map((r) => r.kind);
    expect(kinds[0]).toBe("run.start");
    expect(kinds.at(-1)).toBe("run.end");
    // Agent events are captured in emit order, before the iteration closes.
    const agentEvents = records.filter((r) => r.kind === "agent.event");
    expect(agentEvents.map((r) => (r as Extract<TraceRecord, { kind: "agent.event" }>).event.kind)).toEqual([
      "model-message",
      "tool-call",
    ]);
    expect(records.indexOf(agentEvents[0]!)).toBeLessThan(kinds.indexOf("iteration.end"));

    // Common fields: injected clock + trace id on all, monotonic seq.
    expect(records.every((r) => r.traceId === "T" && r.ts === 1000)).toBe(true);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));

    // run.end carries the rolled-up outcome + the engine's internal run id.
    const end = records.at(-1) as Extract<TraceRecord, { kind: "run.end" }>;
    expect(end.outcome).toBe("success");
    expect(end.iterations).toBe(1);
    expect(typeof end.engineRunId).toBe("string");
  });

  it("writes a valid JSONL file, truncating any prior contents", async () => {
    const file = path.join(workdir, "trace.jsonl");
    writeFileSync(file, "STALE LINE\n");
    await runWithTrace(engineWith(emitter), makeSpec("emitter"), { baseDir: workdir, skipPreflight: true }, jsonlFileSink(file), {
      now: () => 1,
      traceId: "T",
    });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).not.toContain("STALE LINE");
    const parsed = lines.map((l) => JSON.parse(l) as TraceRecord);
    expect(parsed[0]!.kind).toBe("run.start");
    expect(parsed.at(-1)!.kind).toBe("run.end");
    expect(parsed.every((r) => r.traceId === "T")).toBe(true);
  });

  it("never lets a throwing sink break the run, and reports it via onError", async () => {
    const errors: unknown[] = [];
    const badSink = (): void => {
      throw new Error("sink boom");
    };
    const report = await runWithTrace(engineWith(emitter), makeSpec("emitter"), { baseDir: workdir, skipPreflight: true }, badSink, {
      onError: (e) => errors.push(e),
    });
    expect(report.success).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("maps warnings to signals, emitting each once and preferring iteration scope", async () => {
    // A driver that changes nothing while the check still passes → a vacuous
    // warning that appears at both iteration and run scope in the report.
    const noop: AgentDriver = {
      name: "noop",
      async run() {
        return { ok: true, stopReason: "completed", changedFiles: [] };
      },
    };
    const spec = parseSpec({
      name: "vac",
      requirements: "nothing",
      driver: { uses: "noop" },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
      success: { type: "all-pass" },
      limits: { maxIterations: 1, baseline: false },
    });
    const { records, sink } = arraySink();
    await runWithTrace(engineWith(noop), spec, { baseDir: workdir, skipPreflight: true }, sink);

    const vacuous = signals(records).filter((s) => /vacuous/i.test(s.message));
    expect(vacuous).toHaveLength(1);
    expect(vacuous[0]!.scope).toBe("iteration");
    // The git-unavailable caveat is a distinct, run-scoped signal.
    expect(signals(records).some((s) => s.scope === "run")).toBe(true);
  });

  it("generates a trace id when none is injected", () => {
    const { sink } = arraySink();
    const rec = createTraceRecorder(sink);
    expect(typeof rec.traceId).toBe("string");
    expect(rec.traceId.length).toBeGreaterThan(0);
  });
});
