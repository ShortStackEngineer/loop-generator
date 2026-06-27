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
}

/** Consolidated feedback from the previous iteration, handed to the agent. */
export interface FeedbackSummary {
  /** Whether the previous iteration satisfied the success criteria. */
  passed: boolean;
  /** One-line reason from the criteria evaluation. */
  reason: string;
  /** Rendered, agent-facing feedback block. */
  text: string;
  /** Per-evaluator breakdown for drivers that want structured access. */
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
  /** Driver-specific options from `driver.options` in the spec. */
  options: Record<string, unknown>;
  /** Aborts on iteration timeout or run cancellation. */
  signal?: AbortSignal;
  log: Logger;
}

export interface AgentRunResult {
  /** False means the driver itself failed (not that the code is wrong). */
  ok: boolean;
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
