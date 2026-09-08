import type { Command } from "commander";
import { loadChecksFile, ChecksManifestError } from "../check-validation/manifest";
import { writeCheckValidationReportFile } from "../check-validation/report";
import {
  checkValidationExitCode,
  runCheckValidation,
  type CheckRunResult,
  type CheckValidationReport,
} from "../check-validation/runner";

interface ValidateChecksFlags {
  report?: string;
}

const CHECK_MARK: Record<CheckRunResult["status"], string> = {
  passed: "✓",
  rejected: "✗",
  error: "!",
};

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no detail)";
}

function clip(text: string, max = 160): string {
  const line = firstLine(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formatCheck(r: CheckRunResult, pad = "  "): string {
  const exit = r.exitCode === null ? "exit —" : `exit ${r.exitCode}`;
  return `${pad}${CHECK_MARK[r.status]} ${r.check}  ${r.status}  ${exit}`;
}

export function formatCheckValidationReport(report: CheckValidationReport): string {
  const head =
    report.outcome === "validated"
      ? "✓ VALIDATED"
      : report.outcome === "gaps"
        ? "⚠ GAPS"
        : "✗ ERROR";
  const lines: string[] = [`\n${head} — ${report.name}`, `outcome: ${report.outcome}`, `goal: ${clip(report.goal)}`];

  lines.push("", "control:");
  if (!report.control.length) lines.push("  (none)");
  for (const r of report.control) lines.push(formatCheck(r));

  lines.push("", "counterexamples:");
  if (!report.counterexamples.length) {
    lines.push("  (not run)");
  } else {
    for (const ce of report.counterexamples) {
      const mark = ce.status === "caught" ? "✓" : ce.status === "escaped" ? "⚠" : "!";
      lines.push(`  ${mark} ${ce.id}  ${ce.status}  claim=${ce.claim}`);
      for (const r of ce.checks) lines.push(formatCheck(r, "      "));
    }
  }

  lines.push("", "claims:");
  for (const c of report.claims) {
    const mark = c.status === "validated" ? "✓" : c.status === "gap" ? "⚠" : "!";
    const evidence: string[] = [];
    if (c.caught?.length) evidence.push(`caught: ${c.caught.join(", ")}`);
    if (c.escaped?.length) evidence.push(`escaped: ${c.escaped.join(", ")}`);
    const extra = evidence.length ? `  (${evidence.join("; ")})` : "";
    lines.push(`  ${mark} ${c.id}  ${c.status}${extra}`);
    lines.push(`      ${clip(c.description)}`);
  }

  if (report.gaps.length) {
    lines.push("", "explicit gaps (unchanged by this run):");
    for (const g of report.gaps) lines.push(`  • ${g}`);
  }

  return lines.join("\n");
}

function printActionableErrors(report: CheckValidationReport): void {
  const notes: string[] = [];
  for (const r of report.control) {
    if (r.status !== "passed") {
      notes.push(`control check "${r.check}" ${r.status}: ${clip(r.feedback)}`);
    }
  }
  for (const ce of report.counterexamples) {
    if (ce.status === "error") {
      const failed = ce.checks.find((c) => c.status === "error");
      notes.push(
        `counterexample "${ce.id}" errored` + (failed ? `: ${clip(failed.feedback)}` : ""),
      );
    } else if (ce.status === "escaped") {
      notes.push(
        `counterexample "${ce.id}" escaped — no check mapped to claim "${ce.claim}" rejected it`,
      );
    }
  }
  for (const c of report.claims) {
    if (c.status === "gap" && !c.escaped?.length) {
      notes.push(`claim "${c.id}" has no mapped counterexample (uncovered)`);
    }
  }
  if (!notes.length) return;
  console.error("\nActionable:");
  for (const n of notes) console.error(`  • ${n}`);
}

export function registerValidateChecks(program: Command): void {
  program
    .command("validate-checks <manifest>")
    .description(
      "Validate acceptance checks against a known-good control and explicit faulty fixtures. Not a security sandbox — the manifest's commands are trusted executable input.",
    )
    .option("--report <file>", "write the JSON report to a file (when a report was produced)")
    .action(async (manifestPath: string, flags: ValidateChecksFlags) => {
      let loaded;
      try {
        loaded = loadChecksFile(manifestPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        if (!(err instanceof ChecksManifestError) && !message.startsWith("Invalid checks manifest")) {
          console.error("hint: a .checks.yaml must parse as YAML/JSON and satisfy the checks-manifest schema.");
        }
        process.exit(2);
      }

      const controller = new AbortController();
      const onSigint = (): void => {
        console.error("received interrupt; aborting check validation…");
        controller.abort();
      };
      process.on("SIGINT", onSigint);

      let report: CheckValidationReport;
      try {
        report = await runCheckValidation(loaded.manifest, {
          baseDir: loaded.baseDir,
          signal: controller.signal,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
        return;
      } finally {
        process.off("SIGINT", onSigint);
      }

      console.log(formatCheckValidationReport(report));
      if (report.outcome !== "validated") printActionableErrors(report);

      if (flags.report) {
        try {
          const out = writeCheckValidationReportFile(flags.report, report);
          console.log(`\nFull report: ${out}`);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
          return;
        }
      }

      process.exit(checkValidationExitCode(report.outcome));
    });
}
