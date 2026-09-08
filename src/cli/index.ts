#!/usr/bin/env node
import { Command } from "commander";
import { registerGenerate } from "./generate";
import { registerRun } from "./run";
import { registerBatch } from "./batch";
import { registerLint } from "./lint";
import { registerList } from "./list";
import { registerVerifyDriver } from "./verify-driver";
import { registerInitTarget } from "./init-target";
import { registerValidateChecks } from "./validate-checks";

const program = new Command();

program
  .name("loopgen")
  .description("Write the definition of done; any agent does the work; you get a report you can review.")
  .version("0.1.0");

registerGenerate(program);
registerRun(program);
registerBatch(program);
registerLint(program);
registerList(program);
registerVerifyDriver(program);
registerInitTarget(program);
registerValidateChecks(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
