#!/usr/bin/env node
import { Command } from "commander";
import { registerGenerate } from "./generate";
import { registerRun } from "./run";
import { registerBatch } from "./batch";
import { registerLint } from "./lint";
import { registerList } from "./list";
import { registerVerifyDriver } from "./verify-driver";
import { registerInitTarget } from "./init-target";

const program = new Command();

program
  .name("loopgen")
  .description("Write the definition of done. Any agent does the work. You get the receipt — a report you can hand to a reviewer, not the agent's word that it's finished.")
  .version("0.1.0");

registerGenerate(program);
registerRun(program);
registerBatch(program);
registerLint(program);
registerList(program);
registerVerifyDriver(program);
registerInitTarget(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
