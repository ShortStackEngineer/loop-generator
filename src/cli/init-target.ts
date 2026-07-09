import type { Command } from "commander";
import {
  initTarget,
  listTargetTemplates,
  resolveTargetTemplate,
} from "../scaffold/init-target";

interface InitTargetFlags {
  dir?: string;
  force?: boolean;
  noGit?: boolean;
  list?: boolean;
}

export function registerInitTarget(program: Command): void {
  program
    .command("init-target [template]")
    .description(
      "Scaffold a minimal RED workspace for illustrative examples that expect ./target (or list templates).",
    )
    .option("-d, --dir <path>", "destination directory", "./target")
    .option("--force", "overwrite scaffold files if the destination is not empty")
    .option("--no-git", "skip git init (change detection will use content hashes)")
    .option("-l, --list", "list available templates and exit")
    .action((template: string | undefined, flags: InitTargetFlags) => {
      if (flags.list || !template) {
        if (!flags.list && !template) {
          // No template and no --list: show help-ish list rather than error hard.
          console.log("Available target templates:\n");
        } else {
          console.log("Available target templates:\n");
        }
        for (const t of listTargetTemplates()) {
          console.log(`  ${t.id.padEnd(22)} ${t.description}`);
          if (t.examples.length) {
            console.log(`${"".padEnd(24)}e.g. ${t.examples[0]}`);
          }
        }
        console.log("\nUsage: loopgen init-target <template|example-path> [-d ./target]");
        if (!flags.list && !template) process.exit(1);
        return;
      }

      const resolved = resolveTargetTemplate(template);
      if (!resolved) {
        console.error(
          `Unknown template "${template}". Run: loopgen init-target --list`,
        );
        process.exit(1);
      }

      try {
        const result = initTarget(template, {
          dest: flags.dir,
          force: flags.force,
          git: !flags.noGit,
        });
        console.log(`Scaffolded template "${result.template}" → ${result.dest}`);
        console.log(`  ${result.files.length} file(s)${result.git ? " · git init" : ""}`);
        for (const f of result.files) console.log(`  - ${f}`);
        console.log(
          "\nNext: npm install (in the target if needed), then loopgen run <spec> with workspace.dir pointing here.",
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
