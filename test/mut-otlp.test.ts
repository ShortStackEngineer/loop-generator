import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toOtlpTracePayload, otlpObserver, tracesUrl, type OtlpTracePayload } from "../src/observers/otlp";
import type { TraceRecord } from "../src/observability/types";
import type { ObserverRunInfo } from "../src/observers/types";
import type { Logger } from "../src/core/logger";
import type { LoopSpec } from "../src/core/spec";
import type { IterationReport, LoopReport } from "../src/core/engine";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Typed record constructor mirroring the existing observers.test.ts pattern. */
const rec = <K extends TraceRecord["kind"]>(fields: Extract<TraceRecord, { kind: K }>): TraceRecord => fields;

const spans = (p: OtlpTracePayload) => p.resourceSpans[0]!.scopeSpans[0]!.spans;

/** OTLP AnyValue as it appears in an emitted attribute. */
interface AnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

function attrVal(span: { attributes: Array<{ key: string; value: AnyValue }> }, key: string): AnyValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

// ── to32Hex (trace id normalization) ─────────────────────────────────────────

describe("mut: to32Hex trace id normalization", () => {
  it("strips dashes and lowercases an already-32-hex uuid", () => {
    // Pins: replace(/-/g, "") removes dashes, the /^[0-9a-f]{32}$/i match, and .toLowerCase().
    const records: TraceRecord[] = [
      rec({ traceId: "12345678-90ab-cdef-1234-567890ABCDEF", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
    ];
    const root = spans(toOtlpTracePayload(records))[0]!;
    // Dashes gone, uppercase folded to lowercase — exact 32-hex.
    expect(root.traceId).toBe("1234567890abcdef1234567890abcdef");
  });

  it("hex-encodes and right-pads a non-hex trace id to exactly 32 chars", () => {
    // Pins: the else branch (regex did NOT match), Buffer.from(s,"utf8").toString("hex"),
    // "0".repeat(32) padding, and .slice(0, 32).
    const records: TraceRecord[] = [
      rec({ traceId: "gg", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
    ];
    const root = spans(toOtlpTracePayload(records))[0]!;
    // "gg" → hex 6767 → padded with "0" to 32 chars.
    expect(root.traceId).toBe("67670000000000000000000000000000");
    expect(root.traceId).toHaveLength(32);
  });

  it("defaults an absent trace id to hex('loopgen')", () => {
    // Pins: records[0]?.traceId ?? "loopgen" default on empty records.
    const root = spans(toOtlpTracePayload([]))[0]!;
    expect(root.traceId).toBe("6c6f6f7067656e000000000000000000");
  });

  it("does not lowercase / re-encode a value the regex must reject (33 hex chars)", () => {
    // A 33-char hex string fails /^[0-9a-f]{32}$/i, so it must be hex-encoded, not returned verbatim.
    const id = "0123456789abcdef0123456789abcdef0"; // 33 chars
    const records: TraceRecord[] = [
      rec({ traceId: id, seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
    ];
    const root = spans(toOtlpTracePayload(records))[0]!;
    expect(root.traceId).not.toBe(id);
    expect(root.traceId).toHaveLength(32);
    // Deterministic: hex-of-utf8 then sliced.
    expect(root.traceId).toBe(Buffer.from(id, "utf8").toString("hex").slice(0, 32));
  });
});

// ── spanIdHex + nextSpan counter ─────────────────────────────────────────────

describe("mut: spanIdHex and the nextSpan counter", () => {
  it("assigns the root span id 0000000000000001 and increments monotonically", () => {
    // Pins spanIdHex's padStart(16, "0") and toString(16); pins nextSpan++ (increment, not decrement).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 11, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 12, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 2, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const root = all.find((s) => !s.parentSpanId)!;
    const iter = all.find((s) => s.name === "iteration 0")!;
    // Root is span #1, iteration is span #2 — exact 16-hex ids from spanIdHex.
    expect(root.spanId).toBe("0000000000000001");
    expect(iter.spanId).toBe("0000000000000002");
    expect(iter.parentSpanId).toBe("0000000000000001");
  });

  it("gives distinct, increasing ids to turn and tool spans", () => {
    // Pins nextSpan++ at each of iter/turn/tool allocation sites (decrement would collide/repeat).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 11, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 12, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "a", ok: true, turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 13, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 3, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 14, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 4, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const root = all.find((s) => !s.parentSpanId)!;
    const iter = all.find((s) => s.name === "iteration 0")!;
    const turn = all.find((s) => s.name === "turn 1")!;
    const tool = all.find((s) => s.name === "tool:Read")!;
    // Root=1, iter=2, turn=3, tool=4. All 16-hex, all distinct.
    expect(root.spanId).toBe("0000000000000001");
    expect(iter.spanId).toBe("0000000000000002");
    expect(turn.spanId).toBe("0000000000000003");
    expect(tool.spanId).toBe("0000000000000004");
    const ids = new Set(all.map((s) => s.spanId));
    expect(ids.size).toBe(all.length);
    all.forEach((s) => expect(s.spanId).toMatch(/^[0-9a-f]{16}$/));
  });
});

// ── nanos (ms → ns) ───────────────────────────────────────────────────────────

describe("mut: nanos timestamp conversion", () => {
  it("appends exactly six zeros (ms→ns) and floors a fractional ms", () => {
    // Pins Math.floor(ts) and the "000000" literal.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 12.9, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 20, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 34, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 2, totalUsage: {}, iterations: 1 }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    // floor(12.9)=12 → "12000000"; end ts 34 → "34000000".
    expect(root.startTimeUnixNano).toBe("12000000");
    expect(root.endTimeUnixNano).toBe("34000000");
  });
});

// ── trunc (attribute truncation at MAX_ATTR=512) ─────────────────────────────

describe("mut: trunc attribute length cap", () => {
  it("leaves a value at exactly the 512-char boundary untouched", () => {
    // Pins the > (not >=) comparison at the boundary: length 512 must NOT be truncated.
    const text = "x".repeat(512);
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 1, kind: "agent.event", iteration: 0, event: { kind: "model-message", text, turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 3, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const turn = spans(toOtlpTracePayload(records)).find((s) => s.name === "turn 1")!;
    const msgEvent = turn.events!.find((e) => e.name === "model-message")!;
    const textAttr = msgEvent.attributes.find((a) => a.key === "text")!;
    expect(textAttr.value.stringValue).toBe(text);
    expect(textAttr.value.stringValue).toHaveLength(512);
    expect(textAttr.value.stringValue).not.toContain("…");
  });

  it("truncates a 513-char value to 511 chars plus an ellipsis", () => {
    // Pins slice(0, MAX_ATTR - 1) and the "…" literal: 513 > 512 → keep 511 + "…" = 512.
    const text = "y".repeat(513);
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 1, kind: "agent.event", iteration: 0, event: { kind: "model-message", text, turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 3, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const turn = spans(toOtlpTracePayload(records)).find((s) => s.name === "turn 1")!;
    const msgEvent = turn.events!.find((e) => e.name === "model-message")!;
    const got = msgEvent.attributes.find((a) => a.key === "text")!.value.stringValue as string;
    expect(got).toBe(`${"y".repeat(511)}…`);
    expect(got).toHaveLength(512);
    expect(got.endsWith("…")).toBe(true);
  });
});

// ── kv (typed OTLP AnyValue construction) ────────────────────────────────────

describe("mut: kv typed value encoding", () => {
  // Drive kv through iteration attributes (usage numbers, booleans) and root attributes.
  it("encodes booleans as boolValue, integers as intValue (string), doubles as doubleValue", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({
        traceId: "abc",
        seq: 1,
        ts: 1,
        kind: "iteration.end",
        iteration: 0,
        satisfied: true,
        reason: "ok",
        durationMs: 1,
        changed: false,
        usage: { inputTokens: 7, outputTokens: 3 },
        evaluations: [],
      }),
      rec({
        traceId: "abc",
        seq: 2,
        ts: 2,
        kind: "run.end",
        outcome: "success",
        success: true,
        reason: "done",
        durationMs: 1,
        totalUsage: { inputTokens: 100, costUsd: 0.25 },
        iterations: 1,
      }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const iter = all.find((s) => s.name === "iteration 0")!;
    const root = all.find((s) => !s.parentSpanId)!;

    // boolean → { boolValue: true } (and false, not dropped)
    expect(attrVal(iter, "iteration.satisfied")).toEqual({ boolValue: true });
    expect(attrVal(iter, "iteration.changed")).toEqual({ boolValue: false });
    // integer → { intValue: "7" } (String(), not number)
    expect(attrVal(iter, "usage.input_tokens")).toEqual({ intValue: "7" });
    expect(attrVal(iter, "usage.output_tokens")).toEqual({ intValue: "3" });
    expect(attrVal(root, "usage.input_tokens")).toEqual({ intValue: "100" });
    // double (non-integer number) → { doubleValue: 0.25 } (number, not string)
    expect(attrVal(root, "usage.cost_usd")).toEqual({ doubleValue: 0.25 });
    // string → { stringValue }
    expect(attrVal(iter, "iteration.reason")).toEqual({ stringValue: "ok" });
    expect(attrVal(root, "loop.driver")).toEqual({ stringValue: "d" });
  });

  it("drops null/undefined attributes entirely (filtered out, not encoded)", () => {
    // Pins kv's `val === undefined || val === null` guard and the attrs filter.
    // An iteration with no usage / no stopReason must omit those keys entirely.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 1, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    const keys = iter.attributes.map((a) => a.key);
    expect(keys).not.toContain("usage.input_tokens");
    expect(keys).not.toContain("usage.output_tokens");
    expect(keys).not.toContain("agent.stop_reason");
    // But present keys ARE there.
    expect(keys).toContain("iteration.index");
    expect(keys).toContain("iteration.satisfied");
  });

  it("integer zero and boolean false are kept (not treated as falsy-absent)", () => {
    // Guards against kv returning undefined for 0/false — they must be encoded.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({
        traceId: "abc",
        seq: 1,
        ts: 1,
        kind: "iteration.end",
        iteration: 0,
        satisfied: false,
        reason: "no",
        durationMs: 1,
        usage: { inputTokens: 0 },
        evaluations: [],
      }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "run.end", outcome: "max-iterations", success: false, reason: "x", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    expect(attrVal(iter, "iteration.satisfied")).toEqual({ boolValue: false });
    expect(attrVal(iter, "usage.input_tokens")).toEqual({ intValue: "0" });
    // iteration.index is 0 → must still be present as intValue "0".
    expect(attrVal(iter, "iteration.index")).toEqual({ intValue: "0" });
  });
});

// ── root run span ─────────────────────────────────────────────────────────────

describe("mut: root run span assembly", () => {
  const fullRecords = (): TraceRecord[] => [
    rec({ traceId: "abcdef00000000000000000000000000", seq: 0, ts: 100, kind: "run.start", spec: "MySpec", driver: "mock", task: "function" }),
    rec({ traceId: "abcdef00000000000000000000000000", seq: 1, ts: 110, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 10, evaluations: [] }),
    rec({
      traceId: "abcdef00000000000000000000000000",
      seq: 2,
      ts: 200,
      kind: "run.end",
      outcome: "success",
      success: true,
      reason: "converged",
      durationMs: 100,
      totalUsage: { inputTokens: 11, outputTokens: 22, costUsd: 1.5 },
      iterations: 3,
      engineRunId: "engine-xyz",
    }),
  ];

  it("names the root from run.start.spec and stamps every loop/usage attribute", () => {
    const root = spans(toOtlpTracePayload(fullRecords())).find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("MySpec");
    expect(root.kind).toBe(1);
    // Exact attribute keys + values — pins every StringLiteral key and the ObjectLiteral body.
    expect(attrVal(root, "loop.driver")).toEqual({ stringValue: "mock" });
    expect(attrVal(root, "loop.task")).toEqual({ stringValue: "function" });
    expect(attrVal(root, "loop.outcome")).toEqual({ stringValue: "success" });
    expect(attrVal(root, "loop.success")).toEqual({ boolValue: true });
    expect(attrVal(root, "loop.iterations")).toEqual({ intValue: "3" });
    expect(attrVal(root, "loop.reason")).toEqual({ stringValue: "converged" });
    expect(attrVal(root, "loop.engine_run_id")).toEqual({ stringValue: "engine-xyz" });
    expect(attrVal(root, "usage.input_tokens")).toEqual({ intValue: "11" });
    expect(attrVal(root, "usage.output_tokens")).toEqual({ intValue: "22" });
    expect(attrVal(root, "usage.cost_usd")).toEqual({ doubleValue: 1.5 });
  });

  it("uses run.start.ts as start and run.end.ts as end for the root span", () => {
    // Pins runStart?.ts ?? ... and runEnd?.ts ?? ... (?? not &&).
    const root = spans(toOtlpTracePayload(fullRecords())).find((s) => !s.parentSpanId)!;
    expect(root.startTimeUnixNano).toBe("100000000"); // ts 100 → nanos
    expect(root.endTimeUnixNano).toBe("200000000"); // ts 200 → nanos
  });

  it("falls back to first/last record ts when run.start/run.end are absent", () => {
    // Pins the ?? fallbacks: startTs = records[0].ts, endTs = last record ts.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 50, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "hi", turn: 1 } }),
      rec({ traceId: "abc", seq: 1, ts: 90, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    // No run.start → name defaults to "loop-run"; start = first record ts 50; end = last record ts 90.
    expect(root.name).toBe("loop-run");
    expect(root.startTimeUnixNano).toBe("50000000");
    expect(root.endTimeUnixNano).toBe("90000000");
  });

  it("sets root status OK (code 1) with no message on a successful run", () => {
    const root = spans(toOtlpTracePayload(fullRecords())).find((s) => !s.parentSpanId)!;
    expect(root.status.code).toBe(1);
    expect(root.status.message).toBeUndefined();
  });

  it("sets root status ERROR (code 2) with the reason as message on a failed run", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: false, reason: "nope", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "run.end", outcome: "max-iterations", success: false, reason: "budget gone", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    expect(root.status.code).toBe(2);
    expect(root.status.message).toBe("budget gone");
  });

  it("sets root status UNSET (code 0) when there is no run.end record", () => {
    // Pins the `runEnd ? ... : { code: 0 }` ternary.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    expect(root.status).toEqual({ code: 0 });
  });

  it("attaches run-scoped signals as 'warning' span events, and omits events when none", () => {
    const withSignal: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 5, kind: "signal", scope: "run", level: "warning", message: "watch out" }),
      rec({ traceId: "abc", seq: 3, ts: 6, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const root = spans(toOtlpTracePayload(withSignal)).find((s) => !s.parentSpanId)!;
    expect(root.events).toEqual([
      { timeUnixNano: "5000000", name: "warning", attributes: [{ key: "message", value: { stringValue: "watch out" } }] },
    ]);

    // No run-scoped signal → events omitted (undefined, not empty array).
    const noSignal: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const rootNoEvents = spans(toOtlpTracePayload(noSignal)).find((s) => !s.parentSpanId)!;
    expect(rootNoEvents.events).toBeUndefined();
  });

  it("does not attach iteration-scoped signals to the root (scope === 'run' filter)", () => {
    // Pins signals.filter(s => s.scope === "run"): an iteration-scoped signal must not reach the root.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "signal", scope: "iteration", iteration: 0, level: "warning", message: "iter-only" }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    expect(root.events).toBeUndefined();
  });
});

// ── iteration span ────────────────────────────────────────────────────────────

describe("mut: iteration span assembly", () => {
  it("names the iteration, parents it to the root, and stamps its attributes", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({
        traceId: "abc",
        seq: 1,
        ts: 40,
        kind: "iteration.end",
        iteration: 2,
        satisfied: true,
        reason: "passed",
        durationMs: 30,
        changed: true,
        stopReason: "completed",
        usage: { inputTokens: 5, outputTokens: 9 },
        evaluations: [],
      }),
      rec({ traceId: "abc", seq: 2, ts: 50, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 40, totalUsage: {}, iterations: 3 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const root = all.find((s) => !s.parentSpanId)!;
    const iter = all.find((s) => s.name === "iteration 2")!;
    expect(iter.name).toBe("iteration 2");
    expect(iter.parentSpanId).toBe(root.spanId);
    expect(iter.kind).toBe(1);
    expect(attrVal(iter, "iteration.index")).toEqual({ intValue: "2" });
    expect(attrVal(iter, "iteration.satisfied")).toEqual({ boolValue: true });
    expect(attrVal(iter, "iteration.reason")).toEqual({ stringValue: "passed" });
    expect(attrVal(iter, "iteration.changed")).toEqual({ boolValue: true });
    expect(attrVal(iter, "agent.stop_reason")).toEqual({ stringValue: "completed" });
    expect(attrVal(iter, "usage.input_tokens")).toEqual({ intValue: "5" });
    expect(attrVal(iter, "usage.output_tokens")).toEqual({ intValue: "9" });
  });

  it("uses the earliest agent event ts as the iteration start, and it.ts as the end", () => {
    // Pins firstTs = Math.min(...evs.map(ts)) and the endTimeUnixNano = nanos(it.ts).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 25, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "b", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 18, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 60, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 70, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    expect(iter.startTimeUnixNano).toBe("18000000"); // min(25,18) = 18
    expect(iter.endTimeUnixNano).toBe("60000000"); // it.ts
  });

  it("falls back to it.ts as the iteration start when no agent events exist", () => {
    // Pins the `evs.length ? Math.min(...) : it.ts` ternary (empty branch).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 33, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 40, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    expect(iter.startTimeUnixNano).toBe("33000000");
    expect(iter.endTimeUnixNano).toBe("33000000");
  });

  it("sets iteration status OK (1) when satisfied, UNSET (0) when not", () => {
    const satisfied: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    expect(spans(toOtlpTracePayload(satisfied)).find((s) => s.name === "iteration 0")!.status).toEqual({ code: 1 });

    const unsatisfied: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: false, reason: "no", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "run.end", outcome: "max-iterations", success: false, reason: "x", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    expect(spans(toOtlpTracePayload(unsatisfied)).find((s) => s.name === "iteration 0")!.status).toEqual({ code: 0 });
  });

  it("attaches only matching iteration-scoped signals as iteration events", () => {
    // Pins signals.filter(s => s.scope === "iteration" && s.iteration === it.iteration):
    // both the scope check and the per-iteration id check.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 1, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "signal", scope: "iteration", iteration: 1, level: "warning", message: "only-iter-1" }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "signal", scope: "run", level: "warning", message: "run-level" }),
      rec({ traceId: "abc", seq: 5, ts: 6, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 2 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const iter0 = all.find((s) => s.name === "iteration 0")!;
    const iter1 = all.find((s) => s.name === "iteration 1")!;
    // iter 0 has no matching signal → no events.
    expect(iter0.events).toBeUndefined();
    // iter 1 gets exactly its own warning (not the run-level one, not from iter 0).
    expect(iter1.events).toEqual([
      { timeUnixNano: "4000000", name: "warning", attributes: [{ key: "message", value: { stringValue: "only-iter-1" } }] },
    ]);
  });

  it("puts un-turned model messages on the iteration span as events", () => {
    // Pins the `flat` model-message → iterEvents path (events with no `turn` are un-attributed).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "no turn here" } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const iter = all.find((s) => s.name === "iteration 0")!;
    expect(iter.events).toEqual([
      { timeUnixNano: "2000000", name: "model-message", attributes: [{ key: "text", value: { stringValue: "no turn here" } }] },
    ]);
    // No turn span was created (event had no turn).
    expect(all.some((s) => s.name.startsWith("turn"))).toBe(false);
  });
});

// ── turn spans ────────────────────────────────────────────────────────────────

describe("mut: turn span assembly", () => {
  it("only emits turn spans for turns with real content, sorted ascending", () => {
    // Pins hasContent (model-message OR tool-call), the sort by turn index, and the skip of bare turns.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      // turn 2 emitted first in time but must sort after turn 1 in the output ordering.
      rec({ traceId: "abc", seq: 1, ts: 10, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Write", id: "b", turn: 2 } }),
      rec({ traceId: "abc", seq: 2, ts: 11, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "hello", turn: 1 } }),
      // turn 3 has only a turn-end marker → no content → no span.
      rec({ traceId: "abc", seq: 3, ts: 12, kind: "agent.event", iteration: 0, event: { kind: "turn-end", turn: 3 } }),
      rec({ traceId: "abc", seq: 4, ts: 13, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 5, ts: 14, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const turnNames = all.filter((s) => s.name.startsWith("turn")).map((s) => s.name);
    // turn 1 and turn 2 present, turn 3 (bare) absent, and turn 1 emitted before turn 2 (ascending sort).
    expect(turnNames).toEqual(["turn 1", "turn 2"]);
  });

  it("stamps turn.index and bounds the turn span by min/max event ts", () => {
    // Pins turn.index attribute, and startTs = min(ts), endTs = max(ts) over the turn's events.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 30, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "m", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 20, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 45, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "a", ok: true, turn: 1 } }),
      rec({ traceId: "abc", seq: 4, ts: 50, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 5, ts: 60, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const turn = spans(toOtlpTracePayload(records)).find((s) => s.name === "turn 1")!;
    expect(attrVal(turn, "turn.index")).toEqual({ intValue: "1" });
    expect(turn.startTimeUnixNano).toBe("20000000"); // min(30,20,45)
    expect(turn.endTimeUnixNano).toBe("45000000"); // max(30,20,45)
    expect(turn.status).toEqual({ code: 0 });
  });

  it("emits a turn span with model-message events and undefined events when it has none", () => {
    // A turn whose only content is a tool-call (no model-message) → events undefined.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Bash", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const turn = spans(toOtlpTracePayload(records)).find((s) => s.name === "turn 1")!;
    expect(turn.events).toBeUndefined();
  });

  it("parents each turn's tool call under the turn, not the iteration", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "x", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const turn = all.find((s) => s.name === "turn 1")!;
    const tool = all.find((s) => s.name === "tool:Read")!;
    expect(tool.parentSpanId).toBe(turn.spanId);
  });
});

// ── tool spans ────────────────────────────────────────────────────────────────

describe("mut: tool span assembly", () => {
  it("pairs a tool-call to its tool-result by id, stamps input/output, and OK status", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 10, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Write", id: "id-1", turn: 1, input: { path: "f.txt" } } }),
      rec({ traceId: "abc", seq: 2, ts: 20, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "id-1", ok: true, turn: 1, output: { bytes: 3 } } }),
      rec({ traceId: "abc", seq: 3, ts: 30, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 40, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Write")!;
    expect(tool.name).toBe("tool:Write");
    expect(tool.kind).toBe(1);
    // Span bounds: call ts → result ts.
    expect(tool.startTimeUnixNano).toBe("10000000");
    expect(tool.endTimeUnixNano).toBe("20000000");
    expect(attrVal(tool, "tool.name")).toEqual({ stringValue: "Write" });
    expect(attrVal(tool, "tool.id")).toEqual({ stringValue: "id-1" });
    // input/output are JSON-stringified.
    expect(attrVal(tool, "tool.input")).toEqual({ stringValue: JSON.stringify({ path: "f.txt" }) });
    expect(attrVal(tool, "tool.output")).toEqual({ stringValue: JSON.stringify({ bytes: 3 }) });
    expect(tool.status).toEqual({ code: 1 });
  });

  it("marks a tool span ERROR (2) when its result reports ok:false", () => {
    // Pins ok = result?.ok ?? true and status code ok ? 1 : 2.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Bash", id: "z", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "z", ok: false, turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "iteration.end", iteration: 0, satisfied: false, reason: "no", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "max-iterations", success: false, reason: "x", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Bash")!;
    expect(tool.status).toEqual({ code: 2 });
  });

  it("defaults a tool span to OK (1) when there is no matching result (ok ?? true)", () => {
    // Pins the `?? true` default when result is undefined.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 5, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Grep", id: "unmatched", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 6, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 7, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Grep")!;
    expect(tool.status).toEqual({ code: 1 });
    // No result → end time falls back to the call ts (resEvent?.ts ?? e.ts).
    expect(tool.startTimeUnixNano).toBe("5000000");
    expect(tool.endTimeUnixNano).toBe("5000000");
  });

  it("omits tool.input and tool.output when the event carries neither", () => {
    // Pins `call.input === undefined ? undefined : JSON.stringify(...)` and the result.output variant.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "a", ok: true, turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Read")!;
    const keys = tool.attributes.map((a) => a.key);
    expect(keys).not.toContain("tool.input");
    expect(keys).not.toContain("tool.output");
    expect(keys).toContain("tool.name");
    expect(keys).toContain("tool.id");
  });

  it("does not pair a result whose id differs from the call id", () => {
    // Pins results.set keyed by e.event.id and the `call.id ? results.get(call.id) : undefined` lookup:
    // a mismatched result must not be treated as this call's result (so status stays default OK).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "call-A", turn: 1 } }),
      // A result for a different id → must NOT attach to call-A.
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "other", ok: false, turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Read")!;
    // Unmatched → default OK, end == call ts (no result found).
    expect(tool.status).toEqual({ code: 1 });
    expect(tool.endTimeUnixNano).toBe("2000000");
  });

  it("hangs un-turned tool calls directly off the iteration span (back-compat)", () => {
    // Pins the final emitToolSpans(flat, iterSpanId) call.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Bash", id: "c" } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "c", ok: true } }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const iter = all.find((s) => s.name === "iteration 0")!;
    const tool = all.find((s) => s.name === "tool:Bash")!;
    expect(tool.parentSpanId).toBe(iter.spanId);
    // No turn span since the call was un-turned.
    expect(all.some((s) => s.name.startsWith("turn"))).toBe(false);
  });
});

// ── model-message span events ────────────────────────────────────────────────

describe("mut: model-message span events", () => {
  it("emits a model-message event only for model-message kind, with the exact text attr", () => {
    // Pins messageEvent: kind === "model-message" gate, event name, and text attribute.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 7, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "the plan", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 8, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 9, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 10, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const turn = spans(toOtlpTracePayload(records)).find((s) => s.name === "turn 1")!;
    // Exactly one model-message event (the tool-call is NOT a model-message).
    expect(turn.events).toEqual([
      { timeUnixNano: "7000000", name: "model-message", attributes: [{ key: "text", value: { stringValue: "the plan" } }] },
    ]);
  });
});

// ── kv/attrs null guard + non-string coercion ───────────────────────────────

describe("mut: kv null guard and non-string handling", () => {
  it("filters out a genuinely null attribute value (not just undefined)", () => {
    // Pins the `|| val === null` half of kv's guard: a null usage number is dropped, not encoded.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({
        traceId: "abc",
        seq: 1,
        ts: 1,
        kind: "iteration.end",
        iteration: 0,
        satisfied: true,
        reason: "ok",
        durationMs: 1,
        // A null slips in via the wire (cast) — must be filtered, never encoded as "null".
        usage: { inputTokens: null as unknown as number },
        evaluations: [],
      }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    const keys = iter.attributes.map((a) => a.key);
    expect(keys).not.toContain("usage.input_tokens");
    // Prove it wasn't smuggled in as the string "null".
    expect(attrVal(iter, "usage.input_tokens")).toBeUndefined();
  });

  it("JSON-stringifies a non-string, non-number, non-boolean attribute value", () => {
    // Pins `typeof val === "string" ? val : JSON.stringify(val)`: an object value must be stringified.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 0, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({
        traceId: "abc",
        seq: 1,
        ts: 1,
        kind: "iteration.end",
        iteration: 0,
        satisfied: true,
        // reason is typed string, but on the wire a driver could hand an object — must be JSON-stringified.
        reason: { nested: 1 } as unknown as string,
        durationMs: 1,
        evaluations: [],
      }),
      rec({ traceId: "abc", seq: 2, ts: 2, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iter = spans(toOtlpTracePayload(records)).find((s) => s.name === "iteration 0")!;
    // Correct: stringValue is the JSON of the object. Mutated (typeof === true): would keep the raw object.
    expect(attrVal(iter, "iteration.reason")).toEqual({ stringValue: JSON.stringify({ nested: 1 }) });
  });
});

// ── run.start / iteration / event partitioning (find/filter integrity) ───────

describe("mut: record partitioning integrity", () => {
  it("finds the run.start by kind even when it is not the first record", () => {
    // Pins records.find(r => r.kind === "run.start"): a leading agent.event must NOT be mistaken for it.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 5, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "pre", turn: 1 } }),
      rec({ traceId: "abc", seq: 1, ts: 6, kind: "run.start", spec: "RealSpec", driver: "realdriver", task: "realtask" }),
      rec({ traceId: "abc", seq: 2, ts: 7, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 8, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const root = spans(toOtlpTracePayload(records)).find((s) => !s.parentSpanId)!;
    // Correct: name from the real run.start. Mutated (find => first record): name would fall back to "loop-run".
    expect(root.name).toBe("RealSpec");
    expect(attrVal(root, "loop.driver")).toEqual({ stringValue: "realdriver" });
    expect(attrVal(root, "loop.task")).toEqual({ stringValue: "realtask" });
  });

  it("creates exactly one iteration span per iteration.end record (filter by kind)", () => {
    // Pins records.filter(r => r.kind === "iteration.end"): non-iteration records must not spawn iteration spans.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "x", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "signal", scope: "run", level: "warning", message: "w" }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const iterSpans = spans(toOtlpTracePayload(records)).filter((s) => s.name.startsWith("iteration "));
    // Exactly one — 5 records but only 1 iteration.end. Mutated (filter dropped) → one span per record.
    expect(iterSpans).toHaveLength(1);
    expect(iterSpans[0]!.name).toBe("iteration 0");
  });

  it("scopes agent events to their own iteration (no cross-iteration leakage)", () => {
    // Pins eventsFor = agentEvents.filter(e => e.iteration === iteration).
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      // Iteration 0 owns a Read tool call.
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "r0", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      // Iteration 1 owns a Write tool call.
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "agent.event", iteration: 1, event: { kind: "tool-call", name: "Write", id: "w1", turn: 1 } }),
      rec({ traceId: "abc", seq: 4, ts: 5, kind: "iteration.end", iteration: 1, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 5, ts: 6, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 2 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    const iter0 = all.find((s) => s.name === "iteration 0")!;
    const iter1 = all.find((s) => s.name === "iteration 1")!;
    const readTools = all.filter((s) => s.name === "tool:Read");
    const writeTools = all.filter((s) => s.name === "tool:Write");
    // Each tool appears exactly once, under the correct iteration's turn. Mutated (events leak) → duplicated.
    expect(readTools).toHaveLength(1);
    expect(writeTools).toHaveLength(1);
    // The Read tool's turn is a descendant of iteration 0, Write's of iteration 1.
    const turnOfRead = all.find((s) => s.spanId === readTools[0]!.parentSpanId)!;
    const turnOfWrite = all.find((s) => s.spanId === writeTools[0]!.parentSpanId)!;
    expect(turnOfRead.parentSpanId).toBe(iter0.spanId);
    expect(turnOfWrite.parentSpanId).toBe(iter1.spanId);
  });
});

// ── tool pairing edge cases ──────────────────────────────────────────────────

describe("mut: tool pairing edge cases", () => {
  it("never turns a non-tool-call event into a tool span", () => {
    // Pins `if (e.event.kind !== "tool-call") continue;` — an un-turned model-message reaches
    // emitToolSpans(flat, ...) but must NOT become a `tool:undefined` span.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "flat msg" } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const all = spans(toOtlpTracePayload(records));
    expect(all.some((s) => s.name.startsWith("tool:"))).toBe(false);
    expect(all.some((s) => s.name === "tool:undefined")).toBe(false);
  });

  it("does not throw and defaults OK when a turned tool call has no result at all", () => {
    // Pins `resEvent && resEvent.event.kind === "tool-result"` — with resEvent undefined the guard
    // must short-circuit (not dereference undefined.event) and status defaults to OK.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Solo", id: "solo", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    // Must not throw; the tool span exists with OK status.
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:Solo")!;
    expect(tool.status).toEqual({ code: 1 });
  });

  it("only indexes tool-result events (with an id) into the pairing map", () => {
    // Pins `if (e.event.kind === "tool-result" && e.event.id) results.set(...)`.
    // A tool-call that shares an id with a *later* real result must still pair to the real result's
    // ok/output, proving non-tool-results (and id-less events) are not placed in the map.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      // model-message with no id — must not enter the results map.
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "m", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "T", id: "shared", turn: 1 } }),
      // The real result carries ok:false + output; the tool must reflect it.
      rec({ traceId: "abc", seq: 3, ts: 9, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "shared", ok: false, turn: 1, output: "boom" } }),
      rec({ traceId: "abc", seq: 4, ts: 10, kind: "iteration.end", iteration: 0, satisfied: false, reason: "no", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 5, ts: 11, kind: "run.end", outcome: "max-iterations", success: false, reason: "x", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:T")!;
    expect(tool.status).toEqual({ code: 2 }); // paired to the failing result
    expect(attrVal(tool, "tool.output")).toEqual({ stringValue: JSON.stringify("boom") });
    // End time comes from the result (ts 9), not the call (ts 3).
    expect(tool.endTimeUnixNano).toBe("9000000");
  });

  it("does not omit tool.input when it is present (ObjectLiteral/undefined-guard)", () => {
    // Pins `call.input === undefined ? undefined : JSON.stringify(call.input)` present-branch.
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "T", id: "a", turn: 1, input: "raw-in" } }),
      rec({ traceId: "abc", seq: 2, ts: 3, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 1, evaluations: [] }),
      rec({ traceId: "abc", seq: 3, ts: 4, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 1 }),
    ];
    const tool = spans(toOtlpTracePayload(records)).find((s) => s.name === "tool:T")!;
    expect(attrVal(tool, "tool.input")).toEqual({ stringValue: JSON.stringify("raw-in") });
  });
});

// ── resourceSpans / scope shell ──────────────────────────────────────────────

describe("mut: resourceSpans envelope", () => {
  it("wraps spans with the service.name resource attr and the loop-generator scope", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 0 }),
    ];
    const payload = toOtlpTracePayload(records, { serviceName: "my-svc" });
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "my-svc" } },
    ]);
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.scope).toEqual({ name: "loop-generator" });
  });

  it("defaults service.name to loop-generator when none is supplied", () => {
    // Pins opts.serviceName ?? "loop-generator".
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 1, kind: "run.start", spec: "S", driver: "d", task: "t" }),
      rec({ traceId: "abc", seq: 1, ts: 2, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 1, totalUsage: {}, iterations: 0 }),
    ];
    const payload = toOtlpTracePayload(records);
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "loop-generator" } },
    ]);
  });
});

// ── tracesUrl ────────────────────────────────────────────────────────────────

describe("mut: tracesUrl endpoint resolution", () => {
  const savedTraces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const savedBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  afterEach(() => {
    if (savedTraces === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = savedTraces;
    if (savedBase === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedBase;
  });

  it("returns an explicit endpoint verbatim, ignoring env", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://env/v1/traces";
    expect(tracesUrl("http://explicit/v1/traces")).toBe("http://explicit/v1/traces");
  });

  it("uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim over the base var", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://traces-var/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base-var";
    expect(tracesUrl()).toBe("http://traces-var/v1/traces");
  });

  it("appends /v1/traces to the base var, stripping trailing slashes only", () => {
    // Pins the /\/+$/ regex: multiple trailing slashes trimmed, and /v1/traces appended.
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318///";
    expect(tracesUrl()).toBe("http://base:4318/v1/traces");
  });

  it("keeps a base var with no trailing slash intact before appending", () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318";
    expect(tracesUrl()).toBe("http://base:4318/v1/traces");
  });

  it("returns undefined with no endpoint and no env vars set", () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(tracesUrl()).toBeUndefined();
  });
});

// ── otlpObserver: preflight + begin lifecycle + HTTP export ───────────────────

function makeLogger(): { logger: Logger; debug: string[]; warn: string[] } {
  const debug: string[] = [];
  const warn: string[] = [];
  const logger: Logger = {
    level: "debug",
    debug: (m: string) => debug.push(m),
    info: () => {},
    warn: (m: string) => warn.push(m),
    error: () => {},
    child: () => logger,
  };
  return { logger, debug, warn };
}

/** A minimal spec object sufficient for the recorder's start(spec). */
const fakeSpec = {
  name: "obs-spec",
  driver: { uses: "mock" },
  task: { type: "function" },
} as unknown as LoopSpec;

const fakeIteration = {
  iteration: 0,
  satisfied: true,
  reason: "ok",
  durationMs: 1,
  changed: true,
  changedFiles: [],
  warnings: [],
  agent: { stopReason: "completed", usage: {} },
  evaluations: [],
} as unknown as IterationReport;

const fakeReport = {
  outcome: "success",
  success: true,
  reason: "done",
  durationMs: 1,
  totalUsage: {},
  iterations: [fakeIteration],
  warnings: [],
} as unknown as LoopReport;

describe("mut: otlpObserver.preflight", () => {
  it("accepts valid options and reports the resolved file path", () => {
    const result = otlpObserver.preflight!({ workdir: ".", options: { file: "trace.otlp.json" } }) as {
      ok: boolean;
      notes?: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.notes).toEqual(["otlp file: trace.otlp.json"]);
  });

  it("joins multiple option issues with '; ' into one error message", () => {
    // Pins `.map(i => i.message).join("; ")`: two invalid fields must both appear, separated by "; ".
    const result = otlpObserver.preflight!({ workdir: ".", options: { serviceName: 5, timeoutMs: -1 } }) as {
      ok: boolean;
      errors?: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    const msg = result.errors![0]!;
    expect(msg.startsWith("otlp observer options: ")).toBe(true);
    // The real zod issue text for both fields is present (not blanked by a map→undefined mutant)...
    expect(msg.toLowerCase()).toContain("expected string");
    // zod v4: positive() → "too small: expected number to be >0"
    expect(msg.toLowerCase()).toMatch(/too small|greater than 0|>0/);
    // ...and the two issues are separated by "; " (not concatenated, not blank).
    expect(msg).toContain("; ");
  });

  it("names and describes the observer with exact strings", () => {
    expect(otlpObserver.name).toBe("otlp");
    expect(otlpObserver.description).toBe("Assemble the run into OTLP/JSON spans and write them to a file.");
  });
});

describe("mut: otlpObserver.begin write-to-file lifecycle", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "mut-otlp-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function begin(options: Record<string, unknown>, log?: Logger) {
    const info: ObserverRunInfo = {
      runId: "run-abc",
      workdir,
      baseDir: workdir,
      spec: fakeSpec,
      log: log ?? makeLogger().logger,
      options,
    };
    return otlpObserver.begin(info);
  }

  it("writes the OTLP payload to a relative file resolved against baseDir", async () => {
    const session = begin({ file: "out.otlp.json" });
    session.onAgentEvent!({ kind: "model-message", text: "hi", turn: 1 }, { iteration: 0 });
    session.onIteration!(fakeIteration);
    await session.onRunEnd!(fakeReport);

    const file = path.join(workdir, "out.otlp.json");
    expect(existsSync(file)).toBe(true);
    const payload = JSON.parse(readFileSync(file, "utf8")) as OtlpTracePayload;
    // The run id becomes the trace id (already 32-hex? "run-abc" is not, so it's hex-encoded).
    const root = spans(payload).find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("obs-spec");
    expect(root.status.code).toBe(1);
    // service.name defaults to loop-generator.
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "loop-generator" } },
    ]);
  });

  it("does not attempt an HTTP export when no endpoint/env is configured (fetch untouched)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    const session = begin({ file: "no-push.otlp.json" });
    session.onIteration!(fakeIteration);
    await session.onRunEnd!(fakeReport);

    // No url → the `if (!url) return;` short-circuit fires; fetch is never called.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(workdir, "no-push.otlp.json"))).toBe(true);
  });

  it("POSTs to the endpoint with content-type + custom headers and the payload body, and debug-logs success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200 } as unknown as Response;
      }),
    );
    const { logger, debug } = makeLogger();
    const session = begin(
      { file: "push.otlp.json", endpoint: "http://collector.test/v1/traces", headers: { authorization: "Bearer TK" } },
      logger,
    );
    session.onAgentEvent!({ kind: "model-message", text: "hi", turn: 1 }, { iteration: 0 });
    session.onIteration!(fakeIteration);
    await session.onRunEnd!(fakeReport);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector.test/v1/traces");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    // content-type literal plus spread custom headers.
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer TK");
    // Body is the JSON-serialized payload.
    const body = JSON.parse(String(calls[0]!.init.body)) as OtlpTracePayload;
    expect(body.resourceSpans[0]!.scopeSpans[0]!.scope).toEqual({ name: "loop-generator" });
    // Success path logs a debug line naming the url.
    expect(debug.some((m) => m === "OTLP trace exported to http://collector.test/v1/traces")).toBe(true);
  });

  it("throws inside postOtlp on a non-ok response and surfaces a warning naming the status", async () => {
    // Pins `if (!res.ok) throw new Error(...)` and the catch → log.warn path.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    const { logger, warn, debug } = makeLogger();
    const session = begin({ file: "fail.otlp.json", endpoint: "http://down.test/v1/traces" }, logger);
    session.onIteration!(fakeIteration);
    await session.onRunEnd!(fakeReport);

    // File is still written despite the failed export.
    expect(existsSync(path.join(workdir, "fail.otlp.json"))).toBe(true);
    // The warning names both the url and the 503-derived message; no success debug line.
    expect(warn.some((m) => m.includes("http://down.test/v1/traces") && m.includes("503"))).toBe(true);
    expect(debug).toHaveLength(0);
  });

  it("resolves an absolute file path without prefixing baseDir", async () => {
    // Pins path.isAbsolute(opts.file) ? opts.file : resolve(baseDir, ...).
    const abs = path.join(workdir, "nested-abs.otlp.json");
    const session = begin({ file: abs });
    session.onIteration!(fakeIteration);
    await session.onRunEnd!(fakeReport);
    expect(existsSync(abs)).toBe(true);
  });
});
