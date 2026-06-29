import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadBatchFile } from "../batch/manifest";
import { runBatch, type BatchItemResult, type BatchReport } from "../batch/runner";
import { LoopEngine } from "../core/engine";
import { createDefaultRegistries } from "../registry";
import { createLogger, type LogLevel } from "../core/logger";

interface BatchFlags {
  concurrency?: string;
  continueOnError?: boolean;
  stopOnError?: boolean;
  maxIterations?: string;
  strictBaseline?: boolean;
  report?: string;
  logLevel?: LogLevel;
}

/** Fixed-width item name, clipped with an ellipsis when too long. */
function clipName(name: string, width = 24): string {
  const s = name.length > width ? `${name.slice(0, width - 1)}…` : name;
  return s.padEnd(width);
}

const MARK: Record<BatchItemResult["status"], string> = {
  success: "✓",
  failed: "✗",
  skipped: "⊘",
  error: "‼",
};

function formatItem(r: BatchItemResult): string {
  const u = r.report?.totalUsage;
  const meta: string[] = [];
  if (r.report) meta.push(`${r.report.iterations.length} iter`);
  if (r.report?.changedFiles) meta.push(`${r.report.changedFiles.length} files`);
  if (typeof u?.costUsd === "number" && u.costUsd > 0) meta.push(`$${u.costUsd.toFixed(2)}`);
  const metaStr = meta.length ? `  (${meta.join(", ")})` : "";
  const warn = r.report?.warnings.length ? `  ⚠${r.report.warnings.length}` : "";
  return `  ${MARK[r.status]} ${clipName(r.name)} ${r.status.padEnd(8)}${metaStr}${warn}  ${r.reason}`;
}

function formatReport(report: BatchReport): string {
  const lines: string[] = [];
  const head = report.success ? "✓ BATCH PASSED" : "✗ BATCH FAILED";
  lines.push(`\n${head}${report.name ? ` — ${report.name}` : ""}`);
  for (const item of report.items) lines.push(formatItem(item));
  const c = report.counts;
  lines.push(
    `\n${c.total} items: ${c.success} ✓ / ${c.failed} ✗ / ${c.skipped} ⊘ / ${c.error} ‼  ·  ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  const u = report.totalUsage;
  if (u.inputTokens || u.outputTokens || u.costUsd || u.turns) {
    const parts: string[] = [];
    if (u.inputTokens || u.outputTokens) parts.push(`${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out tok`);
    if (u.turns) parts.push(`${u.turns} turns`);
    if (typeof u.costUsd === "number") parts.push(`$${u.costUsd.toFixed(4)}`);
    lines.push(`total usage: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function registerBatch(program: Command): void {
  program
    .command("batch <manifest>")
    .description("Run a punch list of loop specs (a .batch.yaml) with ordering + concurrency.")
    .option("-c, --concurrency <n>", "max items running at once (override manifest)")
    .option("-m, --max-iterations <n>", "override every item's iteration budget")
    .option("--strict-baseline", "fail any item whose baseline already passes (vacuous checks)")
    .option("--continue-on-error", "keep going after a failure (override manifest)")
    .option("--stop-on-error", "stop scheduling new items after the first failure")
    .option("--report <file>", "write the full aggregate JSON report to a file")
    .option("--log-level <level>", "debug|info|warn|error|silent", "info")
    .action(async (manifestPath: string, flags: BatchFlags) => {
      const { manifest, baseDir } = loadBatchFile(manifestPath);

      const continueOnError = flags.stopOnError ? false : flags.continueOnError ? true : undefined;
      const log = createLogger(flags.logLevel ?? "info", "loopgen");
      const engine = new LoopEngine(createDefaultRegistries(), log);

      const controller = new AbortController();
      const onSigint = (): void => {
        log.warn("received interrupt; finishing in-flight items, skipping the rest…");
        controller.abort();
      };
      process.on("SIGINT", onSigint);

      let report: BatchReport;
      try {
        report = await runBatch(manifest, engine, {
          baseDir,
          signal: controller.signal,
          concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
          maxIterations: flags.maxIterations ? Number(flags.maxIterations) : undefined,
          baseline: flags.strictBaseline ? "strict" : undefined,
          continueOnError,
          log,
          onItemStart: (name) => log.info(`▶ ${name}`),
          onItem: (r) => log.info(`${MARK[r.status]} ${r.name}: ${r.status} — ${r.reason}`),
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
