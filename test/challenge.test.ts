import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine, type LoopReport } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { preflightFail } from "../src/core/preflight";
import { formatReport } from "../src/cli/run";
import type { AgentDriver } from "../src/drivers/types";
import {
  CHALLENGE_PACKET_RELATIVE,
  ChallengePacketWriteError,
  buildChallengePacket,
  challengePacketPath,
  writeChallengePacket,
  type ChallengePacket,
} from "../src/core/challenge";

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

function readPacket(workdir: string): ChallengePacket {
  const file = challengePacketPath(workdir);
  expect(existsSync(file)).toBe(true);
  expect(readdirSync(path.dirname(file)).sort()).toEqual(["challenge.json", "path-index.json"]);
  return JSON.parse(readFileSync(file, "utf8")) as ChallengePacket;
}

function sampleReport(over: Partial<LoopReport> = {}): LoopReport {
  return {
    spec: "sample",
    runId: "run-1",
    requirements: "do the thing",
    startedAt: "2026-09-24T00:00:00.000Z",
    endedAt: "2026-09-24T00:00:01.000Z",
    outcome: "max-iterations",
    success: false,
    reason: "exhausted 1 iteration(s) without satisfying: failing: check",
    iterations: [
      {
        iteration: 0,
        agent: { ok: true, stopReason: "completed" },
        evaluations: [{ name: "check", type: "command", ok: true, passed: false, feedback: "still red", durationMs: 4 }],
        satisfied: false,
        reason: "failing: check",
        durationMs: 5,
        warnings: ["iteration caveat that stayed a warning"],
      },
    ],
    totalUsage: {},
    durationMs: 1000,
    warnings: ["run caveat that stayed a warning"],
    ...over,
  };
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-challenge-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("buildChallengePacket", () => {
  it("keeps the ask, the decision, per-check feedback, files, and warnings that stayed warnings", () => {
    const packet = buildChallengePacket(sampleReport());

    expect(packet.kind).toBe("loopgen.challenge");
    expect(packet.version).toBe(1);
    expect(packet.runId).toBe("run-1");
    expect(packet.requirements).toBe("do the thing");
    expect(packet.startedAt).toBe("2026-09-24T00:00:00.000Z");
    expect(packet.endedAt).toBe("2026-09-24T00:00:01.000Z");
    expect(packet.outcome).toBe("max-iterations");
    expect(packet.reason).toContain("exhausted");
    expect(packet.warnings).toEqual(["run caveat that stayed a warning"]);
    expect(packet.baseline).toBeUndefined();
    expect(packet.iterations).toEqual([
      {
        iteration: 0,
        checks: [{ name: "check", passed: false, feedback: "still red" }],
        changedFiles: [],
        warnings: ["iteration caveat that stayed a warning"],
      },
    ]);
  });

  it("includes baseline checks when the pre-run evaluation ran", () => {
    const packet = buildChallengePacket(
      sampleReport({
        outcome: "baseline-vacuous",
        iterations: [],
        baseline: {
          satisfied: true,
          reason: "all checks passed",
          evaluations: [{ name: "check", type: "command", ok: true, passed: true, feedback: "already green", durationMs: 1 }],
        },
      }),
    );

    expect(packet.iterations).toEqual([]);
    expect(packet.baseline).toEqual({
      satisfied: true,
      reason: "all checks passed",
      checks: [{ name: "check", passed: true, feedback: "already green" }],
    });
  });
});

describe("challenge packet on every run", () => {
  it("writes one file after a default run, with requirements, run id, times, checks, and files", async () => {
    const requirements = 'Write the string "42" into answer.txt at the workspace root.\n';
    const spec = parseSpec({
      name: "mock-demo",
      requirements,
      driver: {
        uses: "mock",
        options: {
          steps: [
            { files: { "answer.txt": "wrong" }, summary: "first attempt" },
            { files: { "answer.txt": "42" }, summary: "corrected" },
          ],
        },
      },
      evaluators: [{ uses: "command", as: "answer-check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      success: { type: "all-pass" },
      limits: { maxIterations: 5, baseline: false },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);

    expect(report.success).toBe(true);
    expect(report.outcome).toBe("success");
    expect(report.runId).toBe(packet.runId);
    expect(report.requirements).toBe(requirements);
    expect(report.challengePacket).toBe(challengePacketPath(workdir));
    expect(report.challengePacket?.endsWith(CHALLENGE_PACKET_RELATIVE)).toBe(true);
    expect(packet.requirements).toBe(requirements);
    expect(packet.spec).toBe("mock-demo");
    expect(packet.outcome).toBe("success");
    expect(packet.reason).toBe(report.reason);
    expect(Date.parse(packet.startedAt)).not.toBeNaN();
    expect(Date.parse(packet.endedAt)).toBeGreaterThanOrEqual(Date.parse(packet.startedAt));
    expect(packet.startedAt).toBe(report.startedAt);
    expect(packet.endedAt).toBe(report.endedAt);
    // Content-hash fallback is a warning; it does not change the outcome.
    expect(packet.outcome).toBe("success");
    expect(packet.warnings.join(" ")).toMatch(/content hashes/i);
    expect(packet.iterations).toHaveLength(2);
    expect(packet.iterations[0]!.checks).toEqual([
      expect.objectContaining({ name: "answer-check", passed: false }),
    ]);
    expect(packet.iterations[0]!.checks[0]!.feedback).toMatch(/✗/);
    expect(packet.baseline).toBeUndefined();
    expect(packet.iterations[0]!.changedFiles).toContain("answer.txt");
    expect(packet.iterations[0]!.changedFiles.some((f) => f.includes("challenge.json"))).toBe(false);
    expect(packet.iterations[1]!.checks[0]).toMatchObject({ name: "answer-check", passed: true });
    expect(packet.iterations[1]!.changedFiles).toContain("answer.txt");
    expect(report.changedFiles ?? []).not.toContain(CHALLENGE_PACKET_RELATIVE);
    expect(report.changedFiles ?? []).not.toContain(".loopgen/challenge.json");
    expect(report.changedFiles ?? []).not.toContain(".loopgen/path-index.json");
  });

  it("records a vacuous-success warning without changing the outcome", async () => {
    initGitRepo(workdir);
    writeFileSync(path.join(workdir, "answer.txt"), "42");
    const spec = parseSpec({
      name: "noop",
      requirements: "leave the answer alone",
      driver: { uses: "mock", options: { steps: [{ summary: "did nothing" }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 1, baseline: false },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);

    expect(report.outcome).toBe("success");
    expect(report.changedFiles).toEqual([]);
    expect(packet.outcome).toBe("success");
    expect(packet.reason).toBe(report.reason);
    expect(packet.warnings.join(" ")).toMatch(/changed no files/i);
    expect(packet.iterations[0]!.warnings.join(" ")).toMatch(/changed no files/i);
    expect(packet.iterations[0]!.checks[0]).toMatchObject({ name: "check", passed: true });
    expect(packet.iterations[0]!.changedFiles).toEqual([]);
  });

  it("overwrites the same file when a later run stops at a strict baseline", async () => {
    const spec = parseSpec({
      name: "twice",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const first = await engine().run(spec, { baseDir: workdir });
    const firstId = readPacket(workdir).runId;

    const secondSpec = parseSpec({
      name: "twice",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "nope" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2 },
    });
    const second = await engine().run(secondSpec, { baseDir: workdir });
    const packet = readPacket(workdir);

    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("baseline-vacuous");
    expect(second.iterations).toHaveLength(0);
    expect(packet.runId).toBe(second.runId);
    expect(packet.runId).not.toBe(firstId);
    expect(packet.outcome).toBe("baseline-vacuous");
    expect(packet.requirements).toBe("write 42");
    expect(packet.reason).toMatch(/strict baseline/i);
    expect(packet.warnings.join(" ")).toMatch(/already pass/i);
    expect(packet.iterations).toEqual([]);
    expect(packet.baseline?.satisfied).toBe(true);
    expect(packet.baseline?.checks[0]).toMatchObject({ name: "check", passed: true });
    expect(packet.baseline?.checks[0]!.feedback.length).toBeGreaterThan(0);
    expect(readdirSync(path.join(workdir, ".loopgen")).sort()).toEqual(["challenge.json", "path-index.json"]);
  });

  it("writes the packet when preflight fails before any agent turn", async () => {
    const failing: AgentDriver = {
      name: "failing-preflight",
      async preflight() {
        return preflightFail(["binary missing"]);
      },
      async run() {
        throw new Error("agent must not run");
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.register(failing);
    const spec = parseSpec({
      name: "preflight",
      requirements: "the ask that never reached an agent",
      driver: { uses: "failing-preflight" },
      limits: { maxIterations: 1 },
    });

    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);

    expect(report.outcome).toBe("preflight-failed");
    expect(packet.outcome).toBe("preflight-failed");
    expect(packet.reason).toContain("binary missing");
    expect(packet.requirements).toBe("the ask that never reached an agent");
    expect(packet.runId).toBe(report.runId);
    expect(packet.iterations).toEqual([]);
    expect(existsSync(path.join(workdir, "answer.txt"))).toBe(false);
  });

  it("writes the packet when the driver name cannot be resolved", async () => {
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "does-not-exist" },
    });

    const report = await engine().run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);

    expect(report.outcome).toBe("error");
    expect(packet.outcome).toBe("error");
    expect(packet.reason).toContain("Unknown driver");
    expect(packet.requirements).toBe("x");
    expect(packet.runId).toBe(report.runId);
  });

  it("refuses to finish when the packet cannot be written", async () => {
    writeFileSync(path.join(workdir, ".loopgen"), "not a directory");
    const spec = parseSpec({
      name: "bad",
      requirements: "x",
      driver: { uses: "does-not-exist" },
    });

    await expect(engine().run(spec, { baseDir: workdir })).rejects.toBeInstanceOf(ChallengePacketWriteError);
    expect(existsSync(challengePacketPath(workdir))).toBe(false);
  });
});

describe("formatReport", () => {
  it("prints the challenge packet path with the outcome", () => {
    const text = formatReport({
      ...sampleReport({ outcome: "success", success: true, reason: "all checks passed", warnings: ["stayed a warning"] }),
      challengePacket: "/tmp/proj/.loopgen/challenge.json",
      pathIndex: "/tmp/proj/.loopgen/path-index.json",
    });
    expect(text).toContain("outcome: success — all checks passed");
    expect(text).toContain("challenge packet: /tmp/proj/.loopgen/challenge.json");
    expect(text).toContain("path index: /tmp/proj/.loopgen/path-index.json");
    expect(text).toContain("stayed a warning");
  });
});

describe("writeChallengePacket", () => {
  it("replaces an existing packet and leaves no temp file", () => {
    const file = writeChallengePacket(workdir, sampleReport());
    writeChallengePacket(workdir, sampleReport({ runId: "run-2", outcome: "success", success: true }));
    const packet = JSON.parse(readFileSync(file, "utf8")) as ChallengePacket;
    expect(packet.runId).toBe("run-2");
    expect(readdirSync(path.dirname(file))).toEqual(["challenge.json"]);
  });
});
