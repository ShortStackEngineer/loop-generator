import path from "node:path";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import { createTraceRecorder, jsonlFileSink } from "../observability/recorder";
import type { Observer } from "./types";

const optionsSchema = z.object({
  /** Trace file path; relative paths resolve against the run's base dir. */
  file: z.string().default("loopgen-trace.jsonl"),
});

/**
 * Built-in observer that writes a JSONL execution trace — a thin adapter over
 * the Stage-1 trace recorder, using the engine's run id as the trace id so the
 * file correlates with the run. This is the offline default; `otlp` produces the
 * same content as standard OTLP spans.
 */
export const jsonlObserver: Observer = {
  name: "jsonl",
  description: "Write a JSONL execution trace (loop + agent events) to a file.",

  preflight({ options }) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([`jsonl observer options: ${parsed.error.issues.map((i) => i.message).join("; ")}`]);
    }
    return preflightOk([`trace file: ${parsed.data.file}`]);
  },

  begin({ runId, baseDir, spec, options }) {
    const opts = optionsSchema.parse(options);
    const file = path.isAbsolute(opts.file) ? opts.file : path.resolve(baseDir, opts.file);
    const recorder = createTraceRecorder(jsonlFileSink(file), { traceId: runId });
    recorder.start(spec);
    return {
      onIteration: (report) => recorder.onIteration(report),
      onAgentEvent: (event, ctx) => recorder.onAgentEvent(event, { runId, iteration: ctx.iteration }),
      onRunEnd: (report) => recorder.finish(report),
    };
  },
};
