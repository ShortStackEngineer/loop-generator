import path from "node:path";
import { z } from "zod";
import { runCommand, tail } from "../core/exec";
import { preflightFail, preflightOk } from "../core/preflight";
import type { EvaluationContext, EvaluationOutcome, Evaluator } from "./types";

const optionsSchema = z.object({
  /** Shell command to run. Required. */
  command: z.string().min(1),
  /** Subdirectory (relative to the workspace) to run in. */
  cwd: z.string().optional(),
  /** Exit code that counts as a pass (default 0). */
  expectExitCode: z.number().int().default(0),
  /** Per-command timeout in ms. */
  timeoutMs: z.number().int().positive().optional(),
  /** Extra environment variables. */
  env: z.record(z.string(), z.string()).optional(),
  /** Chars of trailing output to feed back to the agent. */
  feedbackChars: z.number().int().positive().default(3000),
  /** Optional regex with one capture group; group 1 is parsed as the numeric score. */
  scoreRegex: z.string().optional(),
  /** When set, pass also requires the score to fall within [gte, lte]. */
  scoreGte: z.number().optional(),
  scoreLte: z.number().optional(),
});

function extractScore(text: string, regex: string): number | undefined {
  try {
    const m = new RegExp(regex, "m").exec(text);
    if (!m || m[1] === undefined) return undefined;
    const n = Number(m[1]);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

/**
 * The workhorse evaluator: run any CLI and treat its exit code (and optionally a
 * parsed numeric score) as the signal. This single evaluator covers test
 * runners, type checkers, linters, formatters, and benchmarks — anything with a
 * shell entry point.
 */
export const commandEvaluator: Evaluator = {
  type: "command",
  description: "Run a shell command; pass on the expected exit code (and optional score threshold).",

  async preflight({ options }) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([`command evaluator: ${parsed.error.issues.map((i) => i.message).join("; ")}`]);
    }
    return preflightOk([`command: \`${parsed.data.command}\``]);
  },

  async evaluate(ctx: EvaluationContext): Promise<EvaluationOutcome> {
    const opts = optionsSchema.parse(ctx.options);
    const cwd = opts.cwd ? path.resolve(ctx.workdir, opts.cwd) : ctx.workdir;

    let result;
    try {
      result = await runCommand(opts.command, {
        cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      return {
        passed: false,
        ok: false,
        feedback: `Could not run \`${opts.command}\`: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }

    const score = opts.scoreRegex ? extractScore(result.combined, opts.scoreRegex) : undefined;

    let passed = result.code === opts.expectExitCode && !result.timedOut;
    const scoreNotes: string[] = [];
    if (passed && (opts.scoreGte !== undefined || opts.scoreLte !== undefined)) {
      if (score === undefined) {
        passed = false;
        scoreNotes.push("expected a score but the scoreRegex matched nothing");
      } else {
        if (opts.scoreGte !== undefined && score < opts.scoreGte) {
          passed = false;
          scoreNotes.push(`score ${score} < required ${opts.scoreGte}`);
        }
        if (opts.scoreLte !== undefined && score > opts.scoreLte) {
          passed = false;
          scoreNotes.push(`score ${score} > allowed ${opts.scoreLte}`);
        }
      }
    }

    const exitLabel = result.timedOut
      ? "TIMED OUT"
      : `exit ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}`;

    const feedbackParts: string[] = [
      `\`${opts.command}\` → ${exitLabel}${passed ? " ✓" : " ✗"}`,
    ];
    if (typeof score === "number") feedbackParts.push(`score: ${score}`);
    if (scoreNotes.length) feedbackParts.push(scoreNotes.join("; "));
    if (!passed) {
      feedbackParts.push("", "output:", tail(result.combined.trim() || "(no output)", opts.feedbackChars));
    }

    return {
      passed,
      ok: true,
      score,
      feedback: feedbackParts.join("\n"),
      details: {
        command: opts.command,
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
    };
  },
};
