import type { Logger } from "../core/logger";
import type { PreflightResult } from "../core/preflight";
import type { EvaluationResult } from "../evaluators/types";

/**
 * An AgentDriver wraps "some coding agent" behind a uniform contract so the loop
 * engine doesn't care whether it's the Claude Agent SDK, a CLI, a remote
 * service, or a scripted mock. Implement this interface to add a new agent
 * backend, then validate it with the conformance harness in `src/testing`.
 */

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Agentic turns consumed, if the backend reports them. */
  turns?: number;
}

/**
 * Why the agent stopped this iteration. Distinguishing "ran out of turns" from
 * "crashed" matters: the former is incomplete work, the latter is a failure.
 * The engine uses this to attach honest warnings to otherwise-green runs.
 */
export type AgentStopReason = "completed" | "max_turns" | "aborted" | "error" | "unknown";

/**
 * A single, vendor-neutral event from inside one `driver.run()` — the agent's
 * per-turn trajectory (model output, tool calls, results). Drivers emit whatever
 * their backend exposes and simply skip variants they can't observe; a sink
 * (OTLP, a JSONL trace, Raindrop) turns these into spans. Correlation and timing
 * (runId, iteration, timestamp) are added by the engine when it forwards them,
 * so the event stays minimal and drivers stay pure.
 *
 * `turn` (1-based within an iteration) is the driver-internal agentic turn the
 * event belongs to. Drivers that can attribute output/tool use to a turn stamp
 * it so a sink can nest tool calls under per-turn spans; drivers that can't leave
 * it undefined and the event sits flat at the iteration level.
 */
export type AgentEvent =
  | { kind: "turn-start"; turn: number }
  | { kind: "turn-end"; turn: number }
  | { kind: "model-message"; text: string; turn?: number }
  | { kind: "tool-call"; name: string; id?: string; turn?: number; input?: unknown }
  | { kind: "tool-result"; id?: string; ok?: boolean; turn?: number; output?: unknown }
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "error"; message: string };

/** Consolidated feedback from the previous iteration, handed to the agent. */
export interface FeedbackSummary {
  /** Whether the previous iteration satisfied the success criteria. */
  passed: boolean;
  /** One-line reason from the criteria evaluation. */
  reason: string;
  /** Rendered, agent-facing feedback block. */
  text: string;
  /** Per-evaluator breakdown for drivers that consume the structured channel (built-in drivers append JSON and/or apply `details.files`). */
  evaluations: EvaluationResult[];
}

export interface AgentInvocation {
  /** Stable id for the whole loop run (useful for session continuity/logging). */
  runId: string;
  /** 0-based iteration index. */
  iteration: number;
  /** Absolute path the agent must confine its edits to. */
  workdir: string;
  /** Role/system framing for the agent. */
  systemPrompt?: string;
  /** The concrete instruction for this iteration. */
  prompt: string;
  /** Feedback from the prior iteration; undefined on the first. */
  feedback?: FeedbackSummary;
  /**
   * Session id from the previous iteration, if any. Drivers that support
   * resuming (and are configured to) can continue that session instead of
   * starting cold — useful after a `max_turns` stop.
   */
  resumeSessionId?: string;
  /** Driver-specific options from `driver.options` in the spec. */
  options: Record<string, unknown>;
  /** Aborts on iteration timeout or run cancellation. */
  signal?: AbortSignal;
  /**
   * Optional sink for inner-trajectory events. Fire-and-forget; the engine
   * supplies an implementation that can't throw. Drivers that can't surface
   * per-turn detail simply never call it — a sparse stream is fine.
   */
  emit?(event: AgentEvent): void;
  log: Logger;
}

export interface AgentRunResult {
  /** False means the driver itself failed (not that the code is wrong). */
  ok: boolean;
  /**
   * Why the agent stopped. `completed` = the agent decided it was done;
   * `max_turns` = it hit its turn budget (incomplete, not a crash); `error` =
   * a real failure; `aborted` = cancelled/timed out.
   */
  stopReason?: AgentStopReason;
  /** Short summary of what the agent reported doing. */
  summary?: string;
  /** Files the agent changed, if the backend can report them. */
  changedFiles?: string[];
  /** Token/cost usage, if known. */
  usage?: AgentUsage;
  /** Opaque, driver-specific handle for resuming a session. */
  sessionId?: string;
  /** Raw transcript/messages for debugging. */
  raw?: unknown;
  /** Populated when ok === false. */
  error?: string;
}

export interface AgentDriver {
  /** Stable identifier referenced by `driver.uses` in a spec. */
  readonly name: string;
  readonly description?: string;
  /** Optional pre-run check (SDK installed? API key present?). */
  preflight?(ctx: { workdir: string; options: Record<string, unknown> }): Promise<PreflightResult>;
  run(invocation: AgentInvocation): Promise<AgentRunResult>;
}
