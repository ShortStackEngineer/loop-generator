#!/usr/bin/env node
import { Command } from "commander";
import { registerGenerate } from "./generate";
import { registerRun } from "./run";
import { registerBatch } from "./batch";
import { registerLint } from "./lint";
import { registerList } from "./list";
import { registerVerifyDriver } from "./verify-driver";

const program = new Command();

program
  .name("loopgen")
  .description("Generate and run agent coding feedback loops.")
  .version("0.1.0");

registerGenerate(program);
registerRun(program);
registerBatch(program);
registerLint(program);
registerList(program);
registerVerifyDriver(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
