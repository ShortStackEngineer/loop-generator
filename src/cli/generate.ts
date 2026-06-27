import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { input, select, confirm } from "@inquirer/prompts";
import { generateSpec, specToYaml, type GenerateInput } from "../generate";
import { createTaskRegistry, createDriverRegistry } from "../registry";

interface GenerateFlags {
  task?: string;
  name?: string;
  language?: string;
  framework?: string;
  driver?: string;
  requirements?: string;
  maxIterations?: string;
  out?: string;
  interactive?: boolean;
  force?: boolean;
}

export function registerGenerate(program: Command): void {
  program
    .command("generate")
    .alias("gen")
    .description("Generate a reusable .loop.yaml spec from high-level inputs.")
    .option("-n, --name <name>", "loop name")
    .option("-t, --task <type>", "task type (function|api|webapp|experiment|...)")
    .option("-l, --language <lang>", "primary language (typescript|python|rust|go|...)")
    .option("-f, --framework <framework>", "framework (optional)")
    .option("-d, --driver <driver>", "agent driver", "claude-agent-sdk")
    .option("-r, --requirements <text>", "requirements text")
    .option("-m, --max-iterations <n>", "max iterations")
    .option("-o, --out <file>", "output file (default: <name>.loop.yaml)")
    .option("-i, --interactive", "prompt for any missing fields")
    .option("--force", "overwrite the output file if it exists")
    .action(async (flags: GenerateFlags) => {
      const tasks = createTaskRegistry();
      const drivers = createDriverRegistry();

      const wantInteractive = flags.interactive || !flags.name || !flags.task || !flags.requirements;
      const isTTY = process.stdin.isTTY;

      let name = flags.name;
      let task = flags.task;
      let language = flags.language;
      let framework = flags.framework;
      let driver = flags.driver ?? "claude-agent-sdk";
      let requirements = flags.requirements;
      let maxIterations = flags.maxIterations ? Number(flags.maxIterations) : undefined;

      if (wantInteractive && isTTY) {
        name ??= await input({ message: "Loop name:", validate: (v) => v.trim() !== "" || "required" });
        task ??= await select({
          message: "Task type:",
          choices: tasks.keys().map((k) => ({ name: k, value: k })),
        });
        language ??= await input({ message: "Primary language:", default: "typescript" });
        framework ??= (await input({ message: "Framework (optional):", default: framework ?? "" })) || undefined;
        driver = await select({
          message: "Agent driver:",
          choices: drivers.keys().map((k) => ({ name: k, value: k })),
          default: driver,
        });
        requirements ??= await input({
          message: "Requirements (what should the agent build?):",
          validate: (v) => v.trim() !== "" || "required",
        });
        maxIterations ??= Number(await input({ message: "Max iterations:", default: "5" }));
      }

      // Validate required fields for non-interactive use.
      const missing = [
        !name && "--name",
        !task && "--task",
        !requirements && "--requirements",
      ].filter(Boolean);
      if (missing.length) {
        throw new Error(
          `Missing required field(s): ${missing.join(", ")}. Re-run with -i for interactive mode, or pass the flags.`,
        );
      }

      const genInput: GenerateInput = {
        name: name!,
        taskType: task!,
        language: language ?? "typescript",
        framework: framework || undefined,
        requirements: requirements!,
        driver,
        maxIterations,
      };

      const spec = generateSpec(genInput);
      const yaml = specToYaml(spec);

      const slug = name!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const outPath = path.resolve(flags.out ?? `${slug || "loop"}.loop.yaml`);

      if (existsSync(outPath) && !flags.force) {
        const overwrite = isTTY
          ? await confirm({ message: `${outPath} exists. Overwrite?`, default: false })
          : false;
        if (!overwrite) throw new Error(`Refusing to overwrite ${outPath} (use --force).`);
      }

      writeFileSync(outPath, yaml);
      console.log(`Wrote ${outPath}`);
      console.log(`\nNext: review the evaluators/success criteria, then run:\n  loopgen run ${path.relative(process.cwd(), outPath)}`);
    });
}
