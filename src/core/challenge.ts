import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoopReport } from "./engine";
import type { ChallengeLesson } from "./lesson";

/**
 * Workspace-relative path of the challenge packet. One file per workspace,
 * overwritten on each run, under the directory change detection already ignores.
 */
export const CHALLENGE_PACKET_RELATIVE = ".loopgen/challenge.json";

/** Absolute path of the challenge packet for a resolved workspace. */
export function challengePacketPath(workdir: string): string {
  return path.join(workdir, CHALLENGE_PACKET_RELATIVE);
}

/** The packet could not be written. A run must not look finished without it. */
export class ChallengePacketWriteError extends Error {
  readonly packetPath: string;

  constructor(packetPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not write challenge packet "${packetPath}": ${detail}`);
    this.name = "ChallengePacketWriteError";
    this.packetPath = packetPath;
  }
}

/** One check as an auditor reads it: name, pass/fail, and the feedback text. */
export interface ChallengeCheck {
  name: string;
  passed: boolean;
  feedback: string;
}

/**
 * One iteration of the run. `iteration` is 0-based, matching `IterationReport`.
 */
export interface ChallengeIteration {
  iteration: number;
  checks: ChallengeCheck[];
  changedFiles: string[];
  /** Caveats recorded for this iteration that did not by themselves change the outcome. */
  warnings: string[];
}

/**
 * Durable evidence for the decision a run made. Written on every `LoopEngine.run`
 * so an auditor can open it later without `--report`, `--trace`, or the process.
 */
export interface ChallengePacket {
  kind: "loopgen.challenge";
  version: 1;
  runId: string;
  /** The ask, from the spec's `requirements`. */
  requirements: string;
  /** Wall-clock start, ISO-8601. */
  startedAt: string;
  /** Wall-clock end, ISO-8601. */
  endedAt: string;
  spec: string;
  outcome: LoopReport["outcome"];
  /** Why the run stopped. */
  reason: string;
  /**
   * Warnings that stayed warnings: they are on the record, and they did not
   * replace `outcome`. Includes run-level caveats (vacuous no-op green, warn-mode
   * tamper, content-hash fallback, and so on).
   */
  warnings: string[];
  iterations: ChallengeIteration[];
  /** Present when the pre-run baseline evaluation ran. */
  baseline?: {
    satisfied: boolean;
    reason: string;
    checks: ChallengeCheck[];
  };
  /**
   * Present when this run ended `baseline-vacuous`, `spec-tampered`,
   * `evaluator-tampered`, or `success` with no file changes. The same object
   * is appended to `.loopgen/lessons.json` so a later lint can cite it after
   * this packet is overwritten.
   */
  lesson?: ChallengeLesson;
}

function toChecks(evaluations: { name: string; passed: boolean; feedback: string }[]): ChallengeCheck[] {
  return evaluations.map((e) => ({ name: e.name, passed: e.passed, feedback: e.feedback }));
}

/** Project a `LoopReport` down to the fields an auditor needs. */
export function buildChallengePacket(report: LoopReport, lesson?: ChallengeLesson): ChallengePacket {
  const packet: ChallengePacket = {
    kind: "loopgen.challenge",
    version: 1,
    runId: report.runId,
    requirements: report.requirements,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    spec: report.spec,
    outcome: report.outcome,
    reason: report.reason,
    warnings: [...report.warnings],
    iterations: report.iterations.map((it) => ({
      iteration: it.iteration,
      checks: toChecks(it.evaluations),
      changedFiles: [...(it.changedFiles ?? [])],
      warnings: [...it.warnings],
    })),
  };
  if (report.baseline) {
    packet.baseline = {
      satisfied: report.baseline.satisfied,
      reason: report.baseline.reason,
      checks: toChecks(report.baseline.evaluations),
    };
  }
  if (lesson) packet.lesson = lesson;
  return packet;
}

/**
 * Write the challenge packet for `report`, replacing any previous packet in
 * this workspace. Returns the absolute path. Throws {@link ChallengePacketWriteError}
 * when the file cannot be written — the caller must not report a finished run
 * that has no packet on disk.
 */
export function writeChallengePacket(
  workdir: string,
  report: LoopReport,
  lesson?: ChallengeLesson,
): string {
  const file = challengePacketPath(workdir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(buildChallengePacket(report, lesson), null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; the original error is the one that matters */
    }
    throw new ChallengePacketWriteError(file, err);
  }
  return file;
}
