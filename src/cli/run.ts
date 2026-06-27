import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadSpecFile } from "../core/spec";
import { LoopEngine, type IterationReport, type LoopReport } from "../core/engine";
import { createDefaultRegistries } from "../registry";
import { createLogger, type LogLevel } from "../core/logger";

interface RunFlags {
  base?: string;
  maxIterations?: string;
  report?: string;
  logLevel?: LogLevel;
  skipPreflight?: boolean;
  dryRun?: boolean;
}

function formatReport(report: LoopReport): string {
  const lines: string[] = [];
  const mark = report.success ? "✓ SUCCESS" : "✗ FAILED";
  lines.push(`\n${mark} — ${report.spec}`);
  lines.push(`outcome: ${report.outcome} — ${report.reason}`);
  lines.push(`iterations: ${report.iterations.length}, time: ${(report.durationMs / 1000).toFixed(1)}s`);
  const u = report.totalUsage;
  if (u.inputTokens || u.outputTokens || u.costUsd) {
    lines.push(
      `usage: ${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out tokens${
        u.costUsd ? `, $${u.costUsd.toFixed(4)}` : ""
      }`,
    );
  }
  return lines.join("\n");
}

function formatIteration(it: IterationReport): string {
  const checks = it.evaluations
    .map((e) => `${e.passed ? "✓" : "✗"} ${e.name}${typeof e.score === "number" ? `=${e.score}` : ""}`)
    .join("  ");
  const agent = it.agent.ok ? "agent ok" : `agent ERROR: ${it.agent.error}`;
  return `  iter ${it.iteration + 1}: ${it.satisfied ? "PASS" : "retry"} — ${agent} — ${checks || "(no checks)"}`;
}

export function registerRun(program: Command): void {
  program
    .command("run <spec>")
    .description("Execute a loop spec until success criteria are met or iterations are exhausted.")
    .option("-b, --base <dir>", "base dir for the spec's relative paths (default: spec's directory)")
    .option("-m, --max-iterations <n>", "override maxIterations from the spec")
    .option("--report <file>", "write the full JSON report to a file")
    .option("--log-level <level>", "debug|info|warn|error|silent", "info")
    .option("--skip-preflight", "skip driver/evaluator preflight checks")
    .action(async (specPath: string, flags: RunFlags) => {
      const { spec, baseDir } = loadSpecFile(specPath);
      if (flags.maxIterations) spec.limits.maxIterations = Number(flags.maxIterations);

      const log = createLogger(flags.logLevel ?? "info", "loopgen");
      const engine = new LoopEngine(createDefaultRegistries(), log);

      const controller = new AbortController();
      const onSigint = (): void => {
        log.warn("received interrupt; aborting after current iteration…");
        controller.abort();
      };
      process.on("SIGINT", onSigint);

      let report: LoopReport;
      try {
        report = await engine.run(spec, {
          baseDir: flags.base ? path.resolve(flags.base) : baseDir,
          signal: controller.signal,
          skipPreflight: flags.skipPreflight,
          onIteration: (it) => console.log(formatIteration(it)),
          log,
        });
      } finally {
        process.off("SIGINT", onSigint);
      }

      console.log(formatReport(report));

      if (flags.report) {
        const out = path.resolve(flags.report);
        writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(`\nFull report: ${out}`);
      }

      process.exit(report.success ? 0 : 1);
    });
}
