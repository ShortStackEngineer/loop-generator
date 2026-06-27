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
  baseline?: boolean;
  skipBaseline?: boolean;
}

function firstLine(text: string | undefined): string {
  if (!text) return "(no detail)";
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no detail)";
}

/** First line, length-capped — full text always lives in the JSON report. */
function clip(text: string | undefined, max = 180): string {
  const line = firstLine(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Terse one-line agent status: stop reason + turns/cost, never the raw log dump. */
function shortAgent(it: IterationReport): string {
  const a = it.agent;
  const u = a.usage;
  const meta: string[] = [];
  if (u?.turns) meta.push(`${u.turns}t`);
  if (typeof u?.costUsd === "number") meta.push(`$${u.costUsd.toFixed(2)}`);
  const metaStr = meta.length ? ` (${meta.join(", ")})` : "";
  if (!a.ok) return `agent ✗ ${a.stopReason ?? "error"}${metaStr}`;
  if (a.stopReason && a.stopReason !== "completed") return `agent ${a.stopReason}${metaStr}`;
  return `agent ok${metaStr}`;
}

function formatIteration(it: IterationReport): string {
  const checks = it.evaluations
    .map((e) => `${e.passed ? "✓" : "✗"} ${e.name}${typeof e.score === "number" ? `=${e.score}` : ""}`)
    .join(" ");
  let changed = "";
  if (it.changed === false) changed = " · no file changes";
  else if (it.changedFiles?.length) changed = ` · ${it.changedFiles.length} file(s)`;

  const lines = [
    `  iter ${it.iteration + 1}: ${it.satisfied ? "PASS" : "retry"} — ${shortAgent(it)} — ${checks || "(no checks)"}${changed}`,
  ];
  if (!it.agent.ok && it.agent.error) lines.push(`         error: ${clip(it.agent.error)}`);
  if (it.agent.ok && it.agent.summary) lines.push(`         summary: ${clip(it.agent.summary)}`);
  for (const w of it.warnings) lines.push(`         ⚠ ${w}`);
  return lines.join("\n");
}

function formatReport(report: LoopReport): string {
  const lines: string[] = [];
  const mark = report.success ? "✓ SUCCESS" : "✗ FAILED";
  lines.push(`\n${mark} — ${report.spec}`);
  lines.push(`outcome: ${report.outcome} — ${report.reason}`);

  if (report.baseline) {
    lines.push(
      `baseline: checks ${report.baseline.satisfied ? "ALREADY PASS ⚠ (likely vacuous)" : "fail as expected"} — ${report.baseline.reason}`,
    );
  }

  lines.push(`iterations: ${report.iterations.length}, time: ${(report.durationMs / 1000).toFixed(1)}s`);

  const u = report.totalUsage;
  if (u.inputTokens || u.outputTokens || u.costUsd || u.turns) {
    const parts: string[] = [];
    if (u.inputTokens || u.outputTokens) parts.push(`${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out tok`);
    if (u.turns) parts.push(`${u.turns} turns`);
    if (typeof u.costUsd === "number") parts.push(`$${u.costUsd.toFixed(4)}`);
    lines.push(`usage: ${parts.join(", ")}`);
  }

  if (report.changedFiles) {
    if (report.changedFiles.length === 0) {
      lines.push("changed: 0 files");
    } else {
      lines.push(`changed: ${report.changedFiles.length} file(s)`);
      if (report.diffStat) lines.push(indent(report.diffStat, "  "));
    }
  }

  if (report.warnings.length) {
    lines.push("");
    lines.push("⚠ warnings:");
    for (const w of dedupe(report.warnings)) lines.push(`  • ${w}`);
  }

  return lines.join("\n");
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
    .option("--baseline", "run a pre-run baseline evaluation (detects vacuous checks)")
    .option("--skip-baseline", "skip the baseline evaluation even if the spec enables it")
    .action(async (specPath: string, flags: RunFlags) => {
      const { spec, baseDir, file } = loadSpecFile(specPath);
      if (flags.maxIterations) spec.limits.maxIterations = Number(flags.maxIterations);

      // Tri-state: --baseline forces on, --skip-baseline forces off, else defer to spec.
      const baseline = flags.baseline ? true : flags.skipBaseline ? false : undefined;

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
          specFile: file,
          signal: controller.signal,
          skipPreflight: flags.skipPreflight,
          baseline,
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
