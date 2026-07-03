import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IterationReport, LoopReport, RunOptions } from "../core/engine";
import type { LoopSpec } from "../core/spec";
import type { EvaluationResult } from "../evaluators/types";
import type {
  EvaluationTrace,
  RecorderOptions,
  TraceCommon,
  TraceRecord,
  TraceRecorder,
  TraceSink,
} from "./types";

function toEvalTrace(e: EvaluationResult): EvaluationTrace {
  return { name: e.name, type: e.type, ok: e.ok, passed: e.passed, score: e.score };
}

/**
 * Build a recorder that turns a loop run into a {@link TraceRecord} stream: wire
 * its `onAgentEvent`/`onIteration` into `engine.run()`, bracket the run with
 * `start(spec)` / `finish(report)`, and every record flows to `sink`. Warnings
 * become `signal` records (deduped across iteration and run scope) — the
 * loop-generator → Raindrop-signal mapping. Every sink call is guarded, so a
 * broken sink degrades the trace but never fails the run.
 */
export function createTraceRecorder(sink: TraceSink, opts: RecorderOptions = {}): TraceRecorder {
  const traceId = opts.traceId ?? randomUUID();
  const now = opts.now ?? Date.now;
  const onError = opts.onError;
  let seq = 0;
  let engineRunId: string | undefined;
  const seenWarnings = new Set<string>();

  const write = (make: (common: TraceCommon) => TraceRecord): void => {
    const record = make({ traceId, seq: seq++, ts: now() });
    try {
      sink(record);
    } catch (err) {
      // Observability must never break a run: a throwing sink is reported (if a
      // handler was given) and otherwise swallowed.
      onError?.(err);
    }
  };

  const emitWarnings = (warnings: string[], scope: "run" | "iteration", iteration?: number): void => {
    for (const message of warnings) {
      if (seenWarnings.has(message)) continue;
      seenWarnings.add(message);
      write((c) => ({ ...c, kind: "signal", scope, iteration, level: "warning", message }));
    }
  };

  return {
    traceId,

    onAgentEvent(event, ctx) {
      engineRunId = ctx.runId;
      write((c) => ({ ...c, kind: "agent.event", iteration: ctx.iteration, event }));
    },

    onIteration(report) {
      write((c) => ({
        ...c,
        kind: "iteration.end",
        iteration: report.iteration,
        satisfied: report.satisfied,
        reason: report.reason,
        durationMs: report.durationMs,
        changed: report.changed,
        changedFiles: report.changedFiles,
        stopReason: report.agent.stopReason,
        usage: report.agent.usage,
        evaluations: report.evaluations.map(toEvalTrace),
      }));
      emitWarnings(report.warnings, "iteration", report.iteration);
    },

    start(spec) {
      write((c) => ({
        ...c,
        kind: "run.start",
        spec: spec.name,
        driver: spec.driver.uses,
        task: spec.task.type,
      }));
    },

    finish(report) {
      // Run-level warnings not already surfaced per-iteration (the report's
      // warnings are a superset of the final iteration's).
      emitWarnings(report.warnings, "run");
      write((c) => ({
        ...c,
        kind: "run.end",
        outcome: report.outcome,
        success: report.success,
        reason: report.reason,
        durationMs: report.durationMs,
        totalUsage: report.totalUsage,
        iterations: report.iterations.length,
        engineRunId,
      }));
    },
  };
}

/** Collect records in memory — the sink for tests and programmatic inspection. */
export function arraySink(): { records: TraceRecord[]; sink: TraceSink } {
  const records: TraceRecord[] = [];
  return { records, sink: (r) => records.push(r) };
}

/**
 * Append each record to a file as JSONL (one JSON object per line). The file is
 * truncated when the sink is created, so each run starts a fresh trace. This is
 * the offline default; an OTLP/Raindrop sink implements the same interface.
 */
export function jsonlFileSink(filePath: string): TraceSink {
  writeFileSync(filePath, "");
  return (record) => appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

/** The minimal shape of a runnable engine — avoids importing the class here. */
interface TraceableRunner {
  run(spec: LoopSpec, opts?: RunOptions): Promise<LoopReport>;
}

function chain<A extends unknown[]>(
  first: ((...args: A) => void) | undefined,
  second: (...args: A) => void,
): (...args: A) => void {
  return (...args) => {
    first?.(...args);
    second(...args);
  };
}

/**
 * Run a spec with tracing wired in: brackets `engine.run()` with a recorder and
 * composes its callbacks with any the caller already passed (so existing
 * progress rendering is preserved). Returns the same `LoopReport` as `run()`.
 */
export async function runWithTrace(
  engine: TraceableRunner,
  spec: LoopSpec,
  runOptions: RunOptions,
  sink: TraceSink,
  opts?: RecorderOptions,
): Promise<LoopReport> {
  const rec = createTraceRecorder(sink, opts);
  rec.start(spec);
  const report = await engine.run(spec, {
    ...runOptions,
    onIteration: chain(runOptions.onIteration, rec.onIteration),
    onAgentEvent: chain(runOptions.onAgentEvent, rec.onAgentEvent),
  });
  rec.finish(report);
  return report;
}
