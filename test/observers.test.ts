import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger, type Logger } from "../src/core/logger";
import { runWithTrace, arraySink } from "../src/observability/recorder";
import { toOtlpTracePayload, otlpObserver, tracesUrl } from "../src/observers/otlp";
import { jsonlObserver } from "../src/observers/jsonl";
import type { AgentDriver } from "../src/drivers/types";
import type { Observer } from "../src/observers/types";
import type { TraceRecord } from "../src/observability/types";

const emitter: AgentDriver = {
  name: "emitter",
  async run(inv) {
    inv.emit?.({ kind: "model-message", text: "planning", turn: 1 });
    inv.emit?.({ kind: "tool-call", name: "Write", id: "t1", turn: 1 });
    inv.emit?.({ kind: "tool-result", id: "t1", ok: true, turn: 1 });
    writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
    return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
  },
};

function specWith(observers: Array<{ uses: string; options?: Record<string, unknown> }>, driver = "emitter") {
  return parseSpec({
    name: "trace-me",
    requirements: "write 42",
    driver: { uses: driver },
    evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
    success: { type: "all-pass" },
    limits: { maxIterations: 1, baseline: false },
    observability: { observers },
  });
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-obs-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

describe("observer plug-in point", () => {
  it("drives a spec-declared observer through its full lifecycle in order", async () => {
    const seen: string[] = [];
    const spy: Observer = {
      name: "spy",
      begin(info) {
        seen.push(`begin:${info.runId.length > 0 ? "run" : "?"}:${info.spec.name}`);
        return {
          onIteration: (r) => seen.push(`iter:${r.iteration}:${r.satisfied}`),
          onAgentEvent: (e, ctx) => seen.push(`event:${ctx.iteration}:${e.kind}`),
          onRunEnd: (r) => {
            seen.push(`end:${r.outcome}`);
          },
        };
      },
    };
    const regs = createDefaultRegistries();
    regs.observers!.register(spy);
    regs.drivers.register(emitter);

    const report = await new LoopEngine(regs, silentLogger).run(specWith([{ uses: "spy" }]), {
      baseDir: workdir,
      skipPreflight: true,
    });

    expect(report.success).toBe(true);
    expect(seen).toEqual([
      "begin:run:trace-me",
      "event:0:model-message",
      "event:0:tool-call",
      "event:0:tool-result",
      "iter:0:true",
      "end:success",
    ]);
  });

  it("isolates a broken observer: a throwing begin and throwing hooks never fail the run", async () => {
    const boomBegin: Observer = {
      name: "boom-begin",
      begin() {
        throw new Error("begin exploded");
      },
    };
    const boomHooks: Observer = {
      name: "boom-hooks",
      begin() {
        return {
          onIteration: () => {
            throw new Error("iter exploded");
          },
          onAgentEvent: () => {
            throw new Error("event exploded");
          },
          onRunEnd: () => {
            throw new Error("end exploded");
          },
        };
      },
    };
    const regs = createDefaultRegistries();
    regs.observers!.register(boomBegin);
    regs.observers!.register(boomHooks);
    regs.drivers.register(emitter);

    const report = await new LoopEngine(regs, silentLogger).run(
      specWith([{ uses: "boom-begin" }, { uses: "boom-hooks" }]),
      { baseDir: workdir, skipPreflight: true },
    );
    expect(report.success).toBe(true);
  });

  it("fails resolution with a clear error for an unknown observer name", async () => {
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    const report = await new LoopEngine(regs, silentLogger).run(specWith([{ uses: "nope" }]), {
      baseDir: workdir,
      skipPreflight: true,
    });
    expect(report.outcome).toBe("error");
    expect(report.reason).toMatch(/nope/);
  });

  it("jsonl observer writes a valid trace file correlated to the run", async () => {
    const file = path.join(workdir, "run.trace.jsonl");
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    await new LoopEngine(regs, silentLogger).run(specWith([{ uses: "jsonl", options: { file } }]), {
      baseDir: workdir,
      skipPreflight: true,
    });

    const records = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as TraceRecord);
    expect(records[0]!.kind).toBe("run.start");
    expect(records.at(-1)!.kind).toBe("run.end");
    expect(records.some((r) => r.kind === "agent.event")).toBe(true);
    // Every record shares the one trace id (the engine's run id).
    const ids = new Set(records.map((r) => r.traceId));
    expect(ids.size).toBe(1);
  });

  it("otlp observer writes a valid OTLP/JSON payload", async () => {
    const file = path.join(workdir, "run.otlp.json");
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    await new LoopEngine(regs, silentLogger).run(specWith([{ uses: "otlp", options: { file } }]), {
      baseDir: workdir,
      skipPreflight: true,
    });

    const payload = JSON.parse(readFileSync(file, "utf8"));
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.find((s: { parentSpanId?: string }) => !s.parentSpanId)).toBeTruthy();
  });
});

describe("toOtlpTracePayload", () => {
  it("assembles a run→iteration→turn→tool span tree with model output as span events", async () => {
    const { records, sink } = arraySink();
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    await runWithTrace(new LoopEngine(regs, silentLogger), specWith([]), { baseDir: workdir, skipPreflight: true }, sink, {
      traceId: "1234567890abcdef1234567890abcdef",
    });

    const payload = toOtlpTracePayload(records);
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("trace-me");
    expect(root.status.code).toBe(1); // success
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);

    const iter = spans.find((s) => s.name === "iteration 0")!;
    expect(iter.parentSpanId).toBe(root.spanId);

    // The agent's turn nests under the iteration; model output rides on the turn.
    const turn = spans.find((s) => s.name === "turn 1")!;
    expect(turn.parentSpanId).toBe(iter.spanId);
    expect(turn.events?.some((e) => e.name === "model-message")).toBe(true);

    // The tool call nests under its turn, not directly under the iteration.
    const tool = spans.find((s) => s.name === "tool:Write")!;
    expect(tool.parentSpanId).toBe(turn.spanId);
  });

  const rec = <K extends TraceRecord["kind"]>(fields: Extract<TraceRecord, { kind: K }>): TraceRecord => fields;

  it("maps a failed run + tool failure + run signal to ERROR status and span events", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "mock", task: "function" }),
      rec({ traceId: "abc", seq: 1, ts: 11, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Bash", id: "x" } }),
      rec({ traceId: "abc", seq: 2, ts: 12, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "x", ok: false, output: "boom" } }),
      rec({ traceId: "abc", seq: 3, ts: 13, kind: "iteration.end", iteration: 0, satisfied: false, reason: "no", durationMs: 3, evaluations: [] }),
      rec({ traceId: "abc", seq: 4, ts: 14, kind: "signal", scope: "run", level: "warning", message: "heads up" }),
      rec({ traceId: "abc", seq: 5, ts: 15, kind: "run.end", outcome: "max-iterations", success: false, reason: "exhausted", durationMs: 5, totalUsage: {}, iterations: 1 }),
    ];
    const payload = toOtlpTracePayload(records, { serviceName: "svc" });
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.status.code).toBe(2); // ERROR
    expect(root.status.message).toBe("exhausted");
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/); // non-hex id gets normalized
    expect(root.events?.some((e) => e.name === "warning")).toBe(true);

    expect(spans.find((s) => s.name === "iteration 0")!.status.code).toBe(0); // UNSET (not satisfied)
    expect(spans.find((s) => s.name === "tool:Bash")!.status.code).toBe(2); // tool failed

    const svc = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === "service.name");
    expect(svc?.value.stringValue).toBe("svc");
  });

  it("nests each turn's tools under its own turn span and keeps un-turned events flat", () => {
    const records: TraceRecord[] = [
      rec({ traceId: "abc", seq: 0, ts: 10, kind: "run.start", spec: "S", driver: "claude-agent-sdk", task: "function" }),
      // Turn 1: think, then a tool call + result.
      rec({ traceId: "abc", seq: 1, ts: 11, kind: "agent.event", iteration: 0, event: { kind: "model-message", text: "reading", turn: 1 } }),
      rec({ traceId: "abc", seq: 2, ts: 12, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Read", id: "a", turn: 1 } }),
      rec({ traceId: "abc", seq: 3, ts: 13, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "a", ok: true, turn: 1 } }),
      // Turn 2: a different tool.
      rec({ traceId: "abc", seq: 4, ts: 14, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Write", id: "b", turn: 2 } }),
      rec({ traceId: "abc", seq: 5, ts: 15, kind: "agent.event", iteration: 0, event: { kind: "tool-result", id: "b", ok: true, turn: 2 } }),
      // A turn-end marker with no content of its own must NOT spawn an empty span.
      rec({ traceId: "abc", seq: 6, ts: 16, kind: "agent.event", iteration: 0, event: { kind: "turn-end", turn: 3 } }),
      // An un-turned tool call falls back to hanging off the iteration span.
      rec({ traceId: "abc", seq: 7, ts: 17, kind: "agent.event", iteration: 0, event: { kind: "tool-call", name: "Bash", id: "c" } }),
      rec({ traceId: "abc", seq: 8, ts: 18, kind: "iteration.end", iteration: 0, satisfied: true, reason: "ok", durationMs: 8, evaluations: [] }),
      rec({ traceId: "abc", seq: 9, ts: 19, kind: "run.end", outcome: "success", success: true, reason: "done", durationMs: 9, totalUsage: {}, iterations: 1 }),
    ];
    const spans = toOtlpTracePayload(records).resourceSpans[0]!.scopeSpans[0]!.spans;
    const iter = spans.find((s) => s.name === "iteration 0")!;
    const turn1 = spans.find((s) => s.name === "turn 1")!;
    const turn2 = spans.find((s) => s.name === "turn 2")!;

    expect(turn1.parentSpanId).toBe(iter.spanId);
    expect(turn2.parentSpanId).toBe(iter.spanId);
    expect(turn1.events?.some((e) => e.name === "model-message")).toBe(true);
    expect(turn1.attributes.find((a) => a.key === "turn.index")?.value.intValue).toBe("1");
    // Turn span bounds span the whole turn, including the tool result.
    expect(turn1.startTimeUnixNano).toBe("11000000");
    expect(turn1.endTimeUnixNano).toBe("13000000");

    // Each tool nests under its own turn.
    expect(spans.find((s) => s.name === "tool:Read")!.parentSpanId).toBe(turn1.spanId);
    expect(spans.find((s) => s.name === "tool:Write")!.parentSpanId).toBe(turn2.spanId);
    // The content-free turn 3 (only a turn-end) produced no span.
    expect(spans.some((s) => s.name === "turn 3")).toBe(false);
    // The un-turned Bash call falls back to the iteration span.
    expect(spans.find((s) => s.name === "tool:Bash")!.parentSpanId).toBe(iter.spanId);
  });

  it("degrades gracefully on empty records", () => {
    const spans = toOtlpTracePayload([]).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("loop-run");
    expect(spans[0]!.status.code).toBe(0);
  });
});

describe("observer preflight", () => {
  it("jsonl + otlp accept valid options and reject malformed ones", async () => {
    expect((await jsonlObserver.preflight!({ workdir: ".", options: { file: "t.jsonl" } })).ok).toBe(true);
    expect((await jsonlObserver.preflight!({ workdir: ".", options: { file: 123 } })).ok).toBe(false);
    expect((await otlpObserver.preflight!({ workdir: ".", options: {} })).ok).toBe(true);
    expect((await otlpObserver.preflight!({ workdir: ".", options: { serviceName: 5 } })).ok).toBe(false);
  });
});

describe("otlp live HTTP export", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the OTLP payload to the endpoint with headers, and still writes the file", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200 } as unknown as Response;
      }),
    );
    const file = path.join(workdir, "push.otlp.json");
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    const report = await new LoopEngine(regs, silentLogger).run(
      specWith([{ uses: "otlp", options: { file, endpoint: "http://collector.test/v1/traces", headers: { authorization: "Bearer k" } } }]),
      { baseDir: workdir, skipPreflight: true },
    );

    expect(report.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://collector.test/v1/traces");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer k");
    // Body is the OTLP payload; the file mirrors it.
    expect(JSON.parse(String(calls[0]!.init.body)).resourceSpans).toBeTruthy();
    expect(JSON.parse(readFileSync(file, "utf8")).resourceSpans).toBeTruthy();
  });

  it("surfaces a failed export as a warning without failing the run", async () => {
    const warnings: string[] = [];
    const noisy: Logger = {
      level: "warn",
      debug: () => {},
      info: () => {},
      warn: (m: string) => {
        warnings.push(m);
      },
      error: () => {},
      child: () => noisy,
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    const file = path.join(workdir, "fail.otlp.json");
    const regs = createDefaultRegistries();
    regs.drivers.register(emitter);
    const report = await new LoopEngine(regs, noisy).run(
      specWith([{ uses: "otlp", options: { file, endpoint: "http://down.test/v1/traces" } }]),
      { baseDir: workdir, skipPreflight: true },
    );

    expect(report.success).toBe(true); // a failed export never fails the run
    expect(readFileSync(file, "utf8")).toContain("resourceSpans"); // file still written
    expect(warnings.some((w) => /OTLP export .* failed: .*503/.test(w))).toBe(true);
  });
});

describe("tracesUrl", () => {
  const savedTraces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const savedBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  afterEach(() => {
    if (savedTraces === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = savedTraces;
    if (savedBase === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedBase;
  });

  it("prefers an explicit endpoint", () => {
    expect(tracesUrl("http://x/v1/traces")).toBe("http://x/v1/traces");
  });
  it("falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector/v1/traces";
    expect(tracesUrl()).toBe("http://collector/v1/traces");
  });
  it("appends /v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT, trimming a trailing slash", () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318/";
    expect(tracesUrl()).toBe("http://base:4318/v1/traces");
  });
  it("returns undefined with no endpoint and no env", () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(tracesUrl()).toBeUndefined();
  });
});
