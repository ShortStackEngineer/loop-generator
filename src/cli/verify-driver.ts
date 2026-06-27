import type { Command } from "commander";
import { createDriverRegistry } from "../registry";
import {
  runDriverConformance,
  formatConformanceReport,
  scriptedMockOptionsFor,
} from "../testing/conformance";
import { createLogger, type LogLevel } from "../core/logger";

interface VerifyFlags {
  scripted?: boolean;
  skip?: string;
  logLevel?: LogLevel;
}

export function registerVerifyDriver(program: Command): void {
  program
    .command("verify-driver <name>")
    .description("Run the conformance harness against a registered driver.")
    .option("--scripted", "treat the driver as scripted (mock-style) and supply step options")
    .option("--skip <names>", "comma-separated scenarios to skip")
    .option("--log-level <level>", "debug|info|warn|error|silent", "warn")
    .action(async (name: string, flags: VerifyFlags) => {
      const drivers = createDriverRegistry();
      const driver = drivers.get(name);
      const log = createLogger(flags.logLevel ?? "warn", "verify");

      // The mock driver is scripted; others (e.g. claude-agent-sdk) act on the prompt.
      const scripted = flags.scripted || driver.name === "mock";

      const report = await runDriverConformance({
        makeDriver: () => driver,
        optionsFor: scripted ? (scenario, token) => scriptedMockOptionsFor(scenario, token) : undefined,
        skip: flags.skip?.split(",").map((s) => s.trim()).filter(Boolean),
        log,
      });

      console.log(formatConformanceReport(report));
      process.exit(report.passed ? 0 : 1);
    });
}
