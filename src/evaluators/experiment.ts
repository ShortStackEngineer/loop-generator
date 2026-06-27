import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { runCommand, tail } from "../core/exec";
import { preflightFail, preflightOk } from "../core/preflight";
import type { EvaluationContext, EvaluationOutcome, Evaluator } from "./types";

const optionsSchema = z
  .object({
    /** Command that prints metrics JSON to stdout. */
    command: z.string().optional(),
    /** Or a JSON file (relative to workspace) the agent/harness produced. */
    metricsFile: z.string().optional(),
    /** Dot-path to the metric within the JSON, e.g. "variantB.conversionRate". */
    metric: z.string().min(1),
    /** Known baseline (e.g. the control's value) to compare against. */
    baseline: z.number().optional(),
    /** Which direction counts as improvement. */
    direction: z.enum(["increase", "decrease"]).default("increase"),
    /** Required absolute improvement over baseline. */
    minDelta: z.number().optional(),
    /** Absolute thresholds, independent of baseline. */
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((o) => o.command || o.metricsFile, {
    message: "experiment evaluator needs either `command` or `metricsFile`",
  });

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluator for experiment-style tasks (A/B tests, perf tuning): read a numeric
 * metric from a JSON payload and decide pass/fail by absolute thresholds and/or
 * improvement over a baseline. The metric value is exposed as `score` so it can
 * also drive a `score` success criterion.
 */
export const experimentEvaluator: Evaluator = {
  type: "experiment",
  description: "Read a numeric metric (from a command's JSON output or a file) and compare to thresholds/baseline.",

  async preflight({ options }) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([`experiment evaluator: ${parsed.error.issues.map((i) => i.message).join("; ")}`]);
    }
    return preflightOk([`experiment metric: ${parsed.data.metric}`]);
  },

  async evaluate(ctx: EvaluationContext): Promise<EvaluationOutcome> {
    const opts = optionsSchema.parse(ctx.options);

    let payloadText: string;
    if (opts.command) {
      let result;
      try {
        result = await runCommand(opts.command, {
          cwd: ctx.workdir,
          timeoutMs: opts.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        return {
          passed: false,
          ok: false,
          feedback: `Could not run metrics command: ${(err as Error).message}`,
          error: (err as Error).message,
        };
      }
      if (result.code !== 0) {
        return {
          passed: false,
          ok: false,
          feedback: `Metrics command failed (exit ${result.code}):\n${tail(result.combined, 2000)}`,
          error: `metrics command exit ${result.code}`,
        };
      }
      payloadText = result.stdout;
    } else {
      try {
        payloadText = readFileSync(path.resolve(ctx.workdir, opts.metricsFile!), "utf8");
      } catch (err) {
        return {
          passed: false,
          ok: false,
          feedback: `Could not read metrics file "${opts.metricsFile}": ${(err as Error).message}`,
          error: (err as Error).message,
        };
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      return {
        passed: false,
        ok: false,
        feedback: `Metrics payload was not valid JSON: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }

    const raw = getPath(payload, opts.metric);
    const value = typeof raw === "number" ? raw : Number(raw);
    if (typeof raw !== "number" && Number.isNaN(value)) {
      return {
        passed: false,
        ok: false,
        feedback: `Metric "${opts.metric}" was not found or not numeric in the payload.`,
        error: "metric missing/non-numeric",
      };
    }

    const reasons: string[] = [];
    let passed = true;

    if (opts.minValue !== undefined && value < opts.minValue) {
      passed = false;
      reasons.push(`value ${value} < minValue ${opts.minValue}`);
    }
    if (opts.maxValue !== undefined && value > opts.maxValue) {
      passed = false;
      reasons.push(`value ${value} > maxValue ${opts.maxValue}`);
    }
    if (opts.baseline !== undefined) {
      const delta = value - opts.baseline;
      const improved = opts.direction === "increase" ? delta : -delta;
      const required = opts.minDelta ?? 0;
      if (improved < required) {
        passed = false;
        reasons.push(
          `improvement ${improved.toFixed(4)} (${opts.direction}) over baseline ${opts.baseline} < required ${required}`,
        );
      } else {
        reasons.push(`improved by ${improved.toFixed(4)} over baseline ${opts.baseline}`);
      }
    }

    return {
      passed,
      ok: true,
      score: value,
      feedback: passed
        ? `${opts.metric} = ${value} ✓ ${reasons.join("; ")}`
        : `${opts.metric} = ${value} ✗ ${reasons.join("; ")}`,
      details: { metric: opts.metric, value, baseline: opts.baseline },
    };
  },
};
