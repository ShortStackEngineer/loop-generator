import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, silentLogger, type Logger } from "../core/logger";
import type { AgentDriver, AgentInvocation, FeedbackSummary } from "../drivers/types";

/**
 * Driver conformance harness — the apparatus for building a new agent
 * integration against. It defines the behavioral contract every `AgentDriver`
 * must satisfy and exercises a real driver against temp workspaces.
 *
 * Two kinds of driver are supported by the same scenarios:
 *  - **prompt-driven** (e.g. the Claude Agent SDK): the scenario's prompt tells
 *    the agent what to do; no extra config needed.
 *  - **scripted** (e.g. the mock): supply `optionsFor` to translate each
 *    scenario's goal into driver options (the same goal, expressed as a script).
 */

export interface ConformanceScenario {
  name: string;
  description: string;
  /** True if the scenario runs two iterations (to test feedback handling). */
  iterative?: boolean;
}

export interface ConformanceOptions {
  /** Factory for the driver under test (fresh instance per call is fine). */
  makeDriver: () => AgentDriver | Promise<AgentDriver>;
  /**
   * For scripted drivers: given a scenario and the per-run token, return the
   * driver options that accomplish the scenario's goal. Omit for prompt-driven
   * drivers that act on the prompt alone.
   */
  optionsFor?: (scenario: ConformanceScenario, token: string, iteration: number) => Record<string, unknown> | undefined;
  /** Skip scenarios by name (e.g. ["honors-abort"] for drivers that can't abort). */
  skip?: string[];
  /** Root for temp workspaces (default: OS tmp). */
  tmpRoot?: string;
  log?: Logger;
}

export interface ConformanceCheck {
  name: string;
  description: string;
  passed: boolean;
  /** Non-fatal observations don't fail the suite but are surfaced. */
  warning?: boolean;
  detail: string;
  durationMs: number;
}

export interface ConformanceReport {
  driver: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

const TARGET_FILE = "OUTPUT.txt";

const SCENARIOS: ConformanceScenario[] = [
  { name: "reports-name", description: "driver exposes a non-empty string name" },
  { name: "creates-file", description: "driver creates a requested file in the workspace" },
  {
    name: "applies-feedback",
    description: "driver changes a file across two iterations using feedback",
    iterative: true,
  },
  { name: "honors-abort", description: "driver rejects or returns ok:false for an aborted signal" },
];

function makeToken(): string {
  return `loopgen-${Math.random().toString(36).slice(2, 10)}`;
}

function makeInvocation(
  workdir: string,
  prompt: string,
  iteration: number,
  options: Record<string, unknown>,
  log: Logger,
  extra: Partial<AgentInvocation> = {},
): AgentInvocation {
  return {
    runId: "conformance",
    iteration,
    workdir,
    prompt,
    options,
    log,
    ...extra,
  };
}

export async function runDriverConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const log = opts.log ?? silentLogger;
  const driver = await opts.makeDriver();
  const skip = new Set(opts.skip ?? []);
  const checks: ConformanceCheck[] = [];

  const optionsFor = (s: ConformanceScenario, token: string, iteration: number): Record<string, unknown> =>
    opts.optionsFor?.(s, token, iteration) ?? {};

  const newWorkspace = (): string =>
    mkdtempSync(path.join(opts.tmpRoot ?? tmpdir(), "loopgen-conformance-"));

  for (const scenario of SCENARIOS) {
    if (skip.has(scenario.name)) {
      checks.push({
        name: scenario.name,
        description: scenario.description,
        passed: true,
        warning: true,
        detail: "skipped",
        durationMs: 0,
      });
      continue;
    }

    const start = Date.now();
    try {
      const check = await runScenario(scenario, driver, optionsFor, newWorkspace, log);
      checks.push({ ...check, durationMs: Date.now() - start });
    } catch (err) {
      checks.push({
        name: scenario.name,
        description: scenario.description,
        passed: false,
        detail: `threw: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      });
    }
  }

  const passed = checks.every((c) => c.passed);
  return { driver: driver.name, passed, checks };
}

async function runScenario(
  scenario: ConformanceScenario,
  driver: AgentDriver,
  optionsFor: (s: ConformanceScenario, token: string, iteration: number) => Record<string, unknown>,
  newWorkspace: () => string,
  log: Logger,
): Promise<Omit<ConformanceCheck, "durationMs">> {
  const base = { name: scenario.name, description: scenario.description };

  if (scenario.name === "reports-name") {
    const ok = typeof driver.name === "string" && driver.name.length > 0;
    return { ...base, passed: ok, detail: ok ? `name="${driver.name}"` : "name is empty or non-string" };
  }

  if (scenario.name === "creates-file") {
    const workdir = newWorkspace();
    try {
      const token = makeToken();
      const prompt = `Create a file named ${TARGET_FILE} at the workspace root whose entire contents are exactly: ${token}`;
      const result = await driver.run(
        makeInvocation(workdir, prompt, 0, optionsFor(scenario, token, 0), log.child(driver.name)),
      );
      if (!result.ok) return { ...base, passed: false, detail: `run returned ok:false (${result.error ?? "no error"})` };
      const filePath = path.join(workdir, TARGET_FILE);
      if (!existsSync(filePath)) return { ...base, passed: false, detail: `${TARGET_FILE} was not created` };
      const got = readFileSync(filePath, "utf8").trim();
      if (got !== token) return { ...base, passed: false, detail: `contents mismatch: got "${got}"` };
      return { ...base, passed: true, detail: `created ${TARGET_FILE} with expected contents` };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  if (scenario.name === "applies-feedback") {
    const workdir = newWorkspace();
    try {
      const wrong = "WRONG";
      const token = makeToken();
      // Iteration 0: produce an intentionally-wrong file.
      const first = await driver.run(
        makeInvocation(
          workdir,
          `Create a file named ${TARGET_FILE} containing exactly: ${wrong}`,
          0,
          optionsFor(scenario, token, 0),
          log.child(driver.name),
        ),
      );
      if (!first.ok) return { ...base, passed: false, detail: `iteration 0 ok:false (${first.error ?? ""})` };

      // Iteration 1: feedback tells the agent the required contents.
      const feedback: FeedbackSummary = {
        passed: false,
        reason: "contents incorrect",
        text: `The file ${TARGET_FILE} must contain exactly: ${token}`,
        evaluations: [],
      };
      const second = await driver.run(
        makeInvocation(
          workdir,
          `Update ${TARGET_FILE} so its entire contents are exactly: ${token}`,
          1,
          optionsFor(scenario, token, 1),
          log.child(driver.name),
          { feedback },
        ),
      );
      if (!second.ok) return { ...base, passed: false, detail: `iteration 1 ok:false (${second.error ?? ""})` };

      const got = readFileSync(path.join(workdir, TARGET_FILE), "utf8").trim();
      if (got !== token) return { ...base, passed: false, detail: `after feedback contents="${got}", expected "${token}"` };
      return { ...base, passed: true, detail: "applied feedback and corrected the file across iterations" };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  if (scenario.name === "honors-abort") {
    const workdir = newWorkspace();
    try {
      const token = makeToken();
      const controller = new AbortController();
      controller.abort();
      let rejected = false;
      let result;
      try {
        result = await driver.run(
          makeInvocation(workdir, `Create ${TARGET_FILE} containing ${token}`, 0, optionsFor(scenario, token, 0), log.child(driver.name), {
            signal: controller.signal,
          }),
        );
      } catch {
        rejected = true;
      }
      const honored = rejected || (result !== undefined && result.ok === false);
      // Drivers that ignore abort still "work"; flag it as a warning, not a failure.
      return {
        ...base,
        passed: true,
        warning: !honored,
        detail: honored
          ? "aborted signal was honored (rejected or ok:false)"
          : "driver ignored an already-aborted signal (acceptable but not ideal)",
      };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  return { ...base, passed: false, detail: "unknown scenario" };
}

/**
 * Convenience `optionsFor` for scripted drivers shaped like the mock (an array
 * of `{ files }` steps). Translates each conformance scenario's goal into steps.
 */
export function scriptedMockOptionsFor(
  scenario: ConformanceScenario,
  token: string,
): Record<string, unknown> | undefined {
  switch (scenario.name) {
    case "creates-file":
      return { steps: [{ files: { [TARGET_FILE]: token } }] };
    case "applies-feedback":
      return { steps: [{ files: { [TARGET_FILE]: "WRONG" } }, { files: { [TARGET_FILE]: token } }] };
    default:
      return undefined;
  }
}

export const conformanceScenarios = SCENARIOS;

/** Pretty-print a conformance report (used by the CLI). */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`Driver conformance: ${report.driver} — ${report.passed ? "PASS" : "FAIL"}`);
  for (const c of report.checks) {
    const mark = c.passed ? (c.warning ? "⚠" : "✓") : "✗";
    lines.push(`  ${mark} ${c.name} — ${c.detail} (${c.durationMs}ms)`);
  }
  return lines.join("\n");
}

export { createLogger };
