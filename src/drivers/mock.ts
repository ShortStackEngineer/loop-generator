import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runCommand } from "../core/exec";
import { preflightOk } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult } from "./types";

const stepSchema = z.object({
  /** Files to write this step: relative path -> contents. */
  files: z.record(z.string(), z.string()).optional(),
  /** Files to delete this step (relative paths). */
  deleteFiles: z.array(z.string()).optional(),
  /** Optional shell command to run this step. */
  run: z.string().optional(),
  /** Summary the driver reports for this step. */
  summary: z.string().optional(),
});

const optionsSchema = z.object({
  /**
   * Ordered steps. On iteration i the driver applies steps[min(i, len-1)], so a
   * two-step script can model "first attempt fails, second attempt fixes it".
   */
  steps: z.array(stepSchema).default([]),
  defaultSummary: z.string().optional(),
});

export type MockStep = z.infer<typeof stepSchema>;

/**
 * A deterministic, offline driver that applies scripted file edits. It exists
 * for two reasons: (1) it lets you exercise the whole engine without API calls,
 * and (2) it's the reference implementation the conformance harness validates,
 * proving the harness itself is correct.
 */
export const mockDriver: AgentDriver = {
  name: "mock",
  description: "Scripted, offline driver that applies predefined file edits per iteration.",

  async preflight() {
    return preflightOk(["mock driver requires no external services"]);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    const opts = optionsSchema.parse(invocation.options);
    const { steps } = opts;

    if (steps.length === 0) {
      return {
        ok: true,
        summary: "mock driver: no steps configured, made no changes",
        changedFiles: [],
      };
    }

    const step = steps[Math.min(invocation.iteration, steps.length - 1)]!;
    const changedFiles: string[] = [];

    try {
      for (const [rel, contents] of Object.entries(step.files ?? {})) {
        const abs = path.resolve(invocation.workdir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
        changedFiles.push(rel);
      }
      for (const rel of step.deleteFiles ?? []) {
        rmSync(path.resolve(invocation.workdir, rel), { force: true });
        changedFiles.push(rel);
      }
      if (step.run) {
        await runCommand(step.run, { cwd: invocation.workdir, signal: invocation.signal });
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    return {
      ok: true,
      summary: step.summary ?? opts.defaultSummary ?? `mock driver applied step ${invocation.iteration}`,
      changedFiles,
    };
  },
};
