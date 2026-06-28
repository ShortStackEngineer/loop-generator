import path from "node:path";
import type { Command } from "commander";
import { lintPath, type LintFinding } from "../lint";

interface LintFlags {
  base?: string;
  strict?: boolean;
  json?: boolean;
}

const ICON: Record<LintFinding["severity"], string> = {
  error: "✗",
  warn: "⚠",
  info: "ℹ",
};

function formatFinding(f: LintFinding): string {
  const where = f.item ? `${f.item}: ` : "";
  const lines = [`  ${ICON[f.severity]} ${where}${f.ruleId} — ${f.message}`];
  if (f.path) lines.push(`      at: ${f.path}`);
  if (f.hint) lines.push(`      hint: ${f.hint}`);
  return lines.join("\n");
}

export function registerLint(program: Command): void {
  program
    .command("lint <path>")
    .description("Statically check a .loop.yaml or .batch.yaml for misconfigurations before running.")
    .option("-b, --base <dir>", "base dir for the spec's relative paths (default: spec's directory)")
    .option("--strict", "exit non-zero on warnings too (not just errors)")
    .option("--json", "emit findings as JSON")
    .action((target: string, flags: LintFlags) => {
      let result;
      try {
        result = lintPath(target, { base: flags.base });
      } catch (err) {
        console.error(`Could not lint ${target}: ${(err as Error).message}`);
        process.exit(2);
      }

      const { kind, findings } = result;
      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.filter((f) => f.severity === "warn").length;
      const infos = findings.filter((f) => f.severity === "info").length;

      if (flags.json) {
        console.log(JSON.stringify({ kind, findings, counts: { errors, warnings, infos } }, null, 2));
      } else {
        const abs = path.resolve(target);
        console.log(`\nlint ${kind}: ${abs}`);
        if (!findings.length) {
          console.log("  ✓ no issues found");
        } else {
          for (const f of findings) console.log(formatFinding(f));
        }
        console.log(`\n${errors} error(s), ${warnings} warning(s), ${infos} info`);
      }

      const failed = errors > 0 || (flags.strict === true && warnings > 0);
      process.exit(failed ? (errors > 0 ? 2 : 1) : 0);
    });
}
