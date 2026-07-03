import type { AgentEvent } from "../drivers/types";
import type { IterationReport, LoopReport } from "../core/engine";
import type { LoopSpec } from "../core/spec";
import type { PreflightResult } from "../core/preflight";

/**
 * An Observer is the fourth plug-in point: a named, spec-referenceable consumer
 * of a run's telemetry. Where drivers/evaluators/tasks shape *what the loop does*,
 * observers watch *how it went* — the loop-level outcomes and the inner agent
 * trajectory — and ship it somewhere (a JSONL file, OTLP spans, a service).
 *
 * Resolution mirrors the other plug-ins: `observability.observers[].uses` names
 * an Observer registered on the observer registry; `.options` are handed to it.
 * The engine begins one session per observer at run start and drives it live.
 * Every hook must be side-effect-only and non-throwing — the engine isolates
 * each call, so a broken observer degrades telemetry but never fails a run.
 */

/** Everything an observer needs to begin watching one run. */
export interface ObserverRunInfo {
  /** The engine's run id — a stable correlation key for this run. */
  runId: string;
  /** Absolute workspace directory the run operates in. */
  workdir: string;
  /** Base dir the spec's relative paths (and observer file paths) resolve against. */
  baseDir: string;
  /** The spec being run. */
  spec: LoopSpec;
  /** This observer's options from its `observability.observers[]` entry. */
  options: Record<string, unknown>;
}

/** A per-run observer session. Every hook is optional and must not throw. */
export interface ObserverSession {
  /** Called after each iteration completes (post-hoc, with its full report). */
  onIteration?(report: IterationReport): void;
  /** Called for each inner-trajectory event a driver emits during an iteration. */
  onAgentEvent?(event: AgentEvent, ctx: { iteration: number }): void;
  /** Called once with the terminal report (any outcome reached after the run began). */
  onRunEnd?(report: LoopReport): void;
}

export interface Observer {
  /** Stable identifier referenced by `observability.observers[].uses`. */
  readonly name: string;
  readonly description?: string;
  /** Optional pre-run validation of this observer's options. */
  preflight?(ctx: { workdir: string; options: Record<string, unknown> }): PreflightResult | Promise<PreflightResult>;
  /** Begin observing a run; return a session bound to this run + options. */
  begin(info: ObserverRunInfo): ObserverSession;
}
