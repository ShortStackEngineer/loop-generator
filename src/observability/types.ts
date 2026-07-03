import type { AgentEvent, AgentStopReason, AgentUsage } from "../drivers/types";
import type { IterationReport, LoopOutcome, LoopReport } from "../core/engine";
import type { LoopSpec } from "../core/spec";

/**
 * A vendor-neutral, JSONL-friendly execution trace for one loop run. It folds
 * two streams into one ordered log: the loop-level shape (run/iteration outcomes,
 * usage, warnings-as-signals) that only loop-generator can see, and the inner
 * agent trajectory (`AgentEvent`s) a driver emits. A sink turns these records
 * into a file, an OTLP span tree, or a Raindrop run — the record model is
 * deliberately close to a span/event stream so that mapping is mechanical.
 */

/** Fields stamped on every record so a sink can order and correlate them. */
export interface TraceCommon {
  /** Correlates every record in one run (a fresh id per recorder). */
  traceId: string;
  /** Monotonic within the trace — orders records independently of the clock. */
  seq: number;
  /** Milliseconds since epoch (injectable clock; may repeat under a fake clock). */
  ts: number;
}

/** The slice of an evaluator result worth putting on the wire. */
export interface EvaluationTrace {
  name: string;
  type: string;
  ok: boolean;
  passed: boolean;
  score?: number;
}

export type TraceRecord =
  | (TraceCommon & { kind: "run.start"; spec: string; driver: string; task: string })
  | (TraceCommon & { kind: "agent.event"; iteration: number; event: AgentEvent })
  | (TraceCommon & {
      kind: "iteration.end";
      iteration: number;
      satisfied: boolean;
      reason: string;
      durationMs: number;
      changed?: boolean;
      changedFiles?: string[];
      stopReason?: AgentStopReason;
      usage?: AgentUsage;
      evaluations: EvaluationTrace[];
    })
  | (TraceCommon & {
      kind: "signal";
      scope: "run" | "iteration";
      iteration?: number;
      level: "warning";
      message: string;
    })
  | (TraceCommon & {
      kind: "run.end";
      outcome: LoopOutcome;
      success: boolean;
      reason: string;
      durationMs: number;
      totalUsage: AgentUsage;
      iterations: number;
      /** The engine's internal run id, captured from agent events when any fired. */
      engineRunId?: string;
    });

/** Where trace records go. Must never throw into the run — the recorder guards it. */
export type TraceSink = (record: TraceRecord) => void;

export interface RecorderOptions {
  /** Injectable clock (default `Date.now`) so traces are deterministic in tests. */
  now?: () => number;
  /** Override the generated trace id (default `randomUUID`). */
  traceId?: string;
  /** Notified if the sink throws; the run is never affected (default: swallow). */
  onError?: (err: unknown) => void;
}

export interface TraceRecorder {
  /** The id stamped on every record this recorder emits. */
  readonly traceId: string;
  /** Wire into `RunOptions.onAgentEvent`. */
  readonly onAgentEvent: (event: AgentEvent, ctx: { runId: string; iteration: number }) => void;
  /** Wire into `RunOptions.onIteration`. */
  readonly onIteration: (report: IterationReport) => void;
  /** Emit `run.start`; call before `engine.run()`. */
  start(spec: LoopSpec): void;
  /** Emit run-level signals + `run.end` from the final report; call after `engine.run()`. */
  finish(report: LoopReport): void;
}
