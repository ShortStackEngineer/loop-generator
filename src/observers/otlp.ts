import path from "node:path";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import { arraySink, createTraceRecorder } from "../observability/recorder";
import type { TraceRecord } from "../observability/types";
import type { AgentEvent } from "../drivers/types";
import type { Observer } from "./types";

/**
 * OTLP observer: collect the run's trace records, then assemble them into
 * standard OpenTelemetry spans (OTLP/HTTP JSON) and write the payload to a file.
 * No OpenTelemetry SDK dependency — the OTLP/JSON shape is a stable public
 * protocol that Raindrop and any OTLP-aware backend ingest. `curl -X POST
 * --data @<file>` at a collector's `/v1/traces`, or point a forwarder at it.
 *
 * Span tree: one root span per run, an iteration span per iteration, a span per
 * agent turn within the iteration, and a child span per tool call nested under
 * its turn. Model output and warnings become span events. Events a driver can't
 * attribute to a turn stay flat on the iteration span (drivers with no turn
 * detail keep the pre-turn shape).
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

/** The agentic turn an event belongs to, if the driver attributed one. */
function turnOf(event: AgentEvent): number | undefined {
  switch (event.kind) {
    case "model-message":
    case "tool-call":
    case "tool-result":
    case "turn-start":
    case "turn-end":
      return event.turn;
    default:
      return undefined;
  }
}

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

  // Turn a set of agent events into a model-message span event, if it is one.
  const messageEvent = (e: Rec<"agent.event">): OtlpEvent | undefined =>
    e.event.kind === "model-message"
      ? { timeUnixNano: nanos(e.ts), name: "model-message", attributes: attrs({ text: e.event.text }) }
      : undefined;

  // Pair tool-call → tool-result by id and push a child span per call, parented
  // to whichever span (turn, or the iteration for un-turned calls) owns them.
  const emitToolSpans = (evs: Rec<"agent.event">[], parentSpanId: string): void => {
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
        parentSpanId,
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
  };

  // One span per iteration; within it, a span per agent turn, and a tool span per
  // tool call nested under its turn.
  for (const it of iterEnds) {
    const iterSpanId = spanIdHex(nextSpan++);
    const evs = eventsFor(it.iteration);
    const firstTs = evs.length ? Math.min(...evs.map((e) => e.ts)) : it.ts;

    // Partition into per-turn groups; events the driver couldn't attribute to a
    // turn stay flat on the iteration span.
    const turnGroups = new Map<number, Rec<"agent.event">[]>();
    const flat: Rec<"agent.event">[] = [];
    for (const e of evs) {
      const t = turnOf(e.event);
      if (t === undefined) {
        flat.push(e);
        continue;
      }
      const group = turnGroups.get(t);
      if (group) group.push(e);
      else turnGroups.set(t, [e]);
    }

    // Iteration span events: model output the driver left un-turned, plus warnings.
    const iterEvents: OtlpEvent[] = [];
    for (const e of flat) {
      const me = messageEvent(e);
      if (me) iterEvents.push(me);
    }
    for (const s of signals.filter((s) => s.scope === "iteration" && s.iteration === it.iteration)) {
      iterEvents.push({ timeUnixNano: nanos(s.ts), name: "warning", attributes: attrs({ message: s.message }) });
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
      events: iterEvents.length ? iterEvents : undefined,
      status: { code: it.satisfied ? 1 : 0 },
    });

    // A span per turn — but only for turns that carry real content (model output
    // or a tool call), so bare turn-end/usage markers don't spawn empty spans.
    for (const [turn, tevs] of [...turnGroups.entries()].sort((a, b) => a[0] - b[0])) {
      const hasContent = tevs.some((e) => e.event.kind === "model-message" || e.event.kind === "tool-call");
      if (!hasContent) continue;
      const turnSpanId = spanIdHex(nextSpan++);
      const turnEvents: OtlpEvent[] = [];
      for (const e of tevs) {
        const me = messageEvent(e);
        if (me) turnEvents.push(me);
      }
      spans.push({
        traceId,
        spanId: turnSpanId,
        parentSpanId: iterSpanId,
        name: `turn ${turn}`,
        kind: 1,
        startTimeUnixNano: nanos(Math.min(...tevs.map((e) => e.ts))),
        endTimeUnixNano: nanos(Math.max(...tevs.map((e) => e.ts))),
        attributes: attrs({ "turn.index": turn }),
        events: turnEvents.length ? turnEvents : undefined,
        status: { code: 0 },
      });
      emitToolSpans(tevs, turnSpanId);
    }

    // Un-turned tool calls hang directly off the iteration span (back-compat).
    emitToolSpans(flat, iterSpanId);
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
  /**
   * OTLP/HTTP traces endpoint to POST the spans to, used verbatim (e.g.
   * "http://localhost:4318/v1/traces"). When omitted, falls back to the standard
   * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` env vars.
   */
  endpoint: z.string().optional(),
  /** Extra HTTP headers for the export (e.g. an auth token / write key). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Abort the export POST after this many ms. */
  timeoutMs: z.number().int().positive().default(10000),
});

/**
 * Resolve the OTLP/HTTP traces URL: an explicit `endpoint` wins, else the
 * standard env vars — `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` verbatim, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` with `/v1/traces` appended. Undefined = no push.
 */
export function tracesUrl(endpoint?: string): string | undefined {
  if (endpoint) return endpoint;
  const full = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (full) return full;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base) return `${base.replace(/\/+$/, "")}/v1/traces`;
  return undefined;
}

async function postOtlp(
  url: string,
  payload: OtlpTracePayload,
  opts: { headers?: Record<string, string>; timeoutMs: number },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

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

  begin({ runId, baseDir, spec, log, options }) {
    const opts = optionsSchema.parse(options);
    const file = path.isAbsolute(opts.file) ? opts.file : path.resolve(baseDir, opts.file);
    const url = tracesUrl(opts.endpoint);
    const { records, sink } = arraySink();
    const recorder = createTraceRecorder(sink, { traceId: runId });
    recorder.start(spec);
    return {
      onIteration: (report) => recorder.onIteration(report),
      onAgentEvent: (event, ctx) => recorder.onAgentEvent(event, { runId, iteration: ctx.iteration }),
      onRunEnd: async (report) => {
        recorder.finish(report);
        const payload = toOtlpTracePayload(records, { serviceName: opts.serviceName });
        writeFileSync(file, JSON.stringify(payload, null, 2));
        if (!url) return;
        // Best-effort push: a failed export is surfaced but never fails the run.
        try {
          await postOtlp(url, payload, { headers: opts.headers, timeoutMs: opts.timeoutMs });
          log.debug(`OTLP trace exported to ${url}`);
        } catch (err) {
          log.warn(`OTLP export to ${url} failed: ${(err as Error).message}`);
        }
      },
    };
  },
};
