import path from "node:path";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import { arraySink, createTraceRecorder } from "../observability/recorder";
import type { TraceRecord } from "../observability/types";
import type { Observer } from "./types";

/**
 * OTLP observer: collect the run's trace records, then assemble them into
 * standard OpenTelemetry spans (OTLP/HTTP JSON) and write the payload to a file.
 * No OpenTelemetry SDK dependency — the OTLP/JSON shape is a stable public
 * protocol that Raindrop and any OTLP-aware backend ingest. `curl -X POST
 * --data @<file>` at a collector's `/v1/traces`, or point a forwarder at it.
 *
 * Span tree: one root span per run, an iteration span per iteration, and a child
 * span per tool call. Model output and warnings become span events.
 */

// ── OTLP/JSON shapes (minimal — only what we emit) ───────────────────────────
interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}
interface OtlpStatus {
  code: 0 | 1 | 2; // UNSET | OK | ERROR
  message?: string;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1; // INTERNAL
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpEvent[];
  status: OtlpStatus;
}
export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
}

const MAX_ATTR = 512;

function to32Hex(s: string): string {
  const stripped = s.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(stripped)) return stripped.toLowerCase();
  const hex = Buffer.from(s, "utf8").toString("hex");
  return (hex + "0".repeat(32)).slice(0, 32);
}

function spanIdHex(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function nanos(ts: number): string {
  return `${Math.floor(ts)}000000`;
}

function trunc(s: string): string {
  return s.length > MAX_ATTR ? `${s.slice(0, MAX_ATTR - 1)}…` : s;
}

function kv(key: string, val: unknown): OtlpKeyValue | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "boolean") return { key, value: { boolValue: val } };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { key, value: { intValue: String(val) } } : { key, value: { doubleValue: val } };
  }
  const s = typeof val === "string" ? val : JSON.stringify(val);
  return { key, value: { stringValue: trunc(s) } };
}

function attrs(entries: Record<string, unknown>): OtlpKeyValue[] {
  return Object.entries(entries)
    .map(([k, v]) => kv(k, v))
    .filter((a): a is OtlpKeyValue => a !== undefined);
}

type Rec<K extends TraceRecord["kind"]> = Extract<TraceRecord, { kind: K }>;

/** Assemble a run's flat trace records into an OTLP/JSON span tree. */
export function toOtlpTracePayload(records: TraceRecord[], opts: { serviceName?: string } = {}): OtlpTracePayload {
  const serviceName = opts.serviceName ?? "loop-generator";
  const runStart = records.find((r): r is Rec<"run.start"> => r.kind === "run.start");
  const runEnd = records.find((r): r is Rec<"run.end"> => r.kind === "run.end");
  const traceId = to32Hex(records[0]?.traceId ?? "loopgen");
  const spans: OtlpSpan[] = [];
  let nextSpan = 1;
  const rootId = spanIdHex(nextSpan++);

  const agentEvents = records.filter((r): r is Rec<"agent.event"> => r.kind === "agent.event");
  const iterEnds = records.filter((r): r is Rec<"iteration.end"> => r.kind === "iteration.end");
  const signals = records.filter((r): r is Rec<"signal"> => r.kind === "signal");
  const eventsFor = (iteration: number) => agentEvents.filter((e) => e.iteration === iteration);

  // Root run span.
  const startTs = runStart?.ts ?? records[0]?.ts ?? 0;
  const endTs = runEnd?.ts ?? records[records.length - 1]?.ts ?? startTs;
  const rootEvents: OtlpEvent[] = signals
    .filter((s) => s.scope === "run")
    .map((s) => ({ timeUnixNano: nanos(s.ts), name: "warning", attributes: attrs({ message: s.message }) }));
  spans.push({
    traceId,
    spanId: rootId,
    name: runStart?.spec ?? "loop-run",
    kind: 1,
    startTimeUnixNano: nanos(startTs),
    endTimeUnixNano: nanos(endTs),
    attributes: attrs({
      "loop.driver": runStart?.driver,
      "loop.task": runStart?.task,
      "loop.outcome": runEnd?.outcome,
      "loop.success": runEnd?.success,
      "loop.iterations": runEnd?.iterations,
      "loop.reason": runEnd?.reason,
      "loop.engine_run_id": runEnd?.engineRunId,
      "usage.input_tokens": runEnd?.totalUsage.inputTokens,
      "usage.output_tokens": runEnd?.totalUsage.outputTokens,
      "usage.cost_usd": runEnd?.totalUsage.costUsd,
    }),
    events: rootEvents.length ? rootEvents : undefined,
    status: runEnd ? { code: runEnd.success ? 1 : 2, message: runEnd.success ? undefined : runEnd.reason } : { code: 0 },
  });

  // One span per iteration, plus a child span per tool call.
  for (const it of iterEnds) {
    const iterSpanId = spanIdHex(nextSpan++);
    const evs = eventsFor(it.iteration);
    const firstTs = evs.length ? Math.min(...evs.map((e) => e.ts)) : it.ts;

    const spanEvents: OtlpEvent[] = [];
    for (const e of evs) {
      if (e.event.kind === "model-message") {
        spanEvents.push({ timeUnixNano: nanos(e.ts), name: "model-message", attributes: attrs({ text: e.event.text }) });
      }
    }
    for (const s of signals.filter((s) => s.scope === "iteration" && s.iteration === it.iteration)) {
      spanEvents.push({ timeUnixNano: nanos(s.ts), name: "warning", attributes: attrs({ message: s.message }) });
    }

    spans.push({
      traceId,
      spanId: iterSpanId,
      parentSpanId: rootId,
      name: `iteration ${it.iteration}`,
      kind: 1,
      startTimeUnixNano: nanos(firstTs),
      endTimeUnixNano: nanos(it.ts),
      attributes: attrs({
        "iteration.index": it.iteration,
        "iteration.satisfied": it.satisfied,
        "iteration.reason": it.reason,
        "iteration.changed": it.changed,
        "agent.stop_reason": it.stopReason,
        "usage.input_tokens": it.usage?.inputTokens,
        "usage.output_tokens": it.usage?.outputTokens,
      }),
      events: spanEvents.length ? spanEvents : undefined,
      status: { code: it.satisfied ? 1 : 0 },
    });

    // Pair tool-call → tool-result by id into child spans.
    const results = new Map<string, Rec<"agent.event">>();
    for (const e of evs) if (e.event.kind === "tool-result" && e.event.id) results.set(e.event.id, e);
    for (const e of evs) {
      if (e.event.kind !== "tool-call") continue;
      const call = e.event;
      const resEvent = call.id ? results.get(call.id) : undefined;
      const result = resEvent && resEvent.event.kind === "tool-result" ? resEvent.event : undefined;
      const ok = result?.ok ?? true;
      spans.push({
        traceId,
        spanId: spanIdHex(nextSpan++),
        parentSpanId: iterSpanId,
        name: `tool:${call.name}`,
        kind: 1,
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(resEvent?.ts ?? e.ts),
        attributes: attrs({
          "tool.name": call.name,
          "tool.id": call.id,
          "tool.input": call.input === undefined ? undefined : JSON.stringify(call.input),
          "tool.output": result?.output === undefined ? undefined : JSON.stringify(result.output),
        }),
        status: { code: ok ? 1 : 2 },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ "service.name": serviceName }) },
        scopeSpans: [{ scope: { name: "loop-generator" }, spans }],
      },
    ],
  };
}

const optionsSchema = z.object({
  /** Output file path; relative paths resolve against the run's base dir. */
  file: z.string().default("loopgen-trace.otlp.json"),
  /** `service.name` resource attribute on the emitted spans. */
  serviceName: z.string().default("loop-generator"),
});

/**
 * Built-in observer that writes the run as an OTLP/JSON trace file. Collects
 * records via the Stage-1 recorder (using the engine run id as the trace id),
 * then assembles + writes the OTLP payload when the run ends.
 */
export const otlpObserver: Observer = {
  name: "otlp",
  description: "Assemble the run into OTLP/JSON spans and write them to a file.",

  preflight({ options }) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([`otlp observer options: ${parsed.error.issues.map((i) => i.message).join("; ")}`]);
    }
    return preflightOk([`otlp file: ${parsed.data.file}`]);
  },

  begin({ runId, baseDir, spec, options }) {
    const opts = optionsSchema.parse(options);
    const file = path.isAbsolute(opts.file) ? opts.file : path.resolve(baseDir, opts.file);
    const { records, sink } = arraySink();
    const recorder = createTraceRecorder(sink, { traceId: runId });
    recorder.start(spec);
    return {
      onIteration: (report) => recorder.onIteration(report),
      onAgentEvent: (event, ctx) => recorder.onAgentEvent(event, { runId, iteration: ctx.iteration }),
      onRunEnd: (report) => {
        recorder.finish(report);
        const payload = toOtlpTracePayload(records, { serviceName: opts.serviceName });
        writeFileSync(file, JSON.stringify(payload, null, 2));
      },
    };
  },
};
