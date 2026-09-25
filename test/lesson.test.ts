import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine, type LoopReport } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec, type LoopSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import { challengePacketPath, type ChallengePacket } from "../src/core/challenge";
import {
  LessonReadError,
  LessonWriteError,
  deriveChallengeLesson,
  evaluatorShape,
  lessonsPath,
  loadWorkspaceLessons,
  matchPriorLessons,
  readLessons,
  recordLesson,
  type ChallengeLesson,
} from "../src/core/lesson";
import { lintPath, lintSpec, workspacePreflight } from "../src/lint";

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function engine(): LoopEngine {
  return new LoopEngine(createDefaultRegistries(), silentLogger);
}

function readPacket(workdir: string): ChallengePacket {
  return JSON.parse(readFileSync(challengePacketPath(workdir), "utf8")) as ChallengePacket;
}

function checkSpec(command: string, over: Record<string, unknown> = {}): LoopSpec {
  return parseSpec({
    name: "checks",
    requirements: "do the thing",
    driver: { uses: "mock", options: { steps: [{ summary: "noop" }] } },
    evaluators: [{ uses: "command", as: "check", options: { command } }],
    limits: { maxIterations: 1, baseline: false },
    ...over,
  });
}

function report(over: Partial<LoopReport> = {}): LoopReport {
  return {
    spec: "checks",
    runId: "run-1",
    requirements: "do the thing",
    startedAt: "2026-09-25T00:00:00.000Z",
    endedAt: "2026-09-25T00:00:01.000Z",
    outcome: "max-iterations",
    success: false,
    reason: "exhausted",
    iterations: [],
    totalUsage: {},
    durationMs: 1,
    warnings: [],
    ...over,
  };
}

const passed = (name: string) => ({
  name,
  type: "command",
  ok: true,
  passed: true,
  feedback: "green",
  durationMs: 1,
});

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-lesson-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("deriveChallengeLesson", () => {
  const spec = checkSpec("true");

  it("records the passing checks for a strict baseline", () => {
    const lesson = deriveChallengeLesson(
      report({
        outcome: "baseline-vacuous",
        baseline: { satisfied: true, reason: "all checks passed", evaluations: [passed("check")] },
      }),
      spec,
      { workdir },
    );
    expect(lesson).toMatchObject({
      failureClass: "baseline-vacuous",
      runId: "run-1",
      subjects: [{ kind: "check", name: "check", shape: evaluatorShape(spec.evaluators[0]!) }],
    });
    expect(lesson?.text).toBe("Checks already passed before any agent work: check.");
  });

  it("records the in-workspace spec file for spec-tampered", () => {
    const lesson = deriveChallengeLesson(report({ outcome: "spec-tampered" }), spec, {
      workdir,
      specRel: "my.loop.yaml",
    });
    expect(lesson).toMatchObject({
      failureClass: "spec-tampered",
      subjects: [{ kind: "file", name: "my.loop.yaml", shape: "my.loop.yaml" }],
    });
    expect(lesson?.text).toContain("my.loop.yaml");
  });

  it("omits a spec-tamper lesson when the spec file is not inside the workspace", () => {
    expect(deriveChallengeLesson(report({ outcome: "spec-tampered" }), spec, { workdir })).toBeUndefined();
  });

  it("records the guarded files for evaluator-tampered", () => {
    const lesson = deriveChallengeLesson(report({ outcome: "evaluator-tampered" }), spec, {
      workdir,
      files: ["test/c_test.rb", path.join(workdir, "test/c_test.rb")],
    });
    expect(lesson?.subjects).toEqual([{ kind: "file", name: "test/c_test.rb", shape: "test/c_test.rb" }]);
    expect(lesson?.text).toContain("test/c_test.rb");
  });

  it("records the passing checks when success changed no files", () => {
    const lesson = deriveChallengeLesson(
      report({
        outcome: "success",
        success: true,
        iterations: [
          {
            iteration: 0,
            agent: { ok: true, stopReason: "completed" },
            evaluations: [passed("check")],
            satisfied: true,
            reason: "all checks passed",
            durationMs: 1,
            changed: false,
            changedFiles: [],
            warnings: ["criteria satisfied but the agent changed no files"],
          },
        ],
      }),
      spec,
      { workdir },
    );
    expect(lesson?.failureClass).toBe("vacuous-success");
    expect(lesson?.text).toBe("Checks passed and no files changed: check.");
  });

  it("omits a lesson for ordinary success, max-iterations, and a green iteration that changed files", () => {
    expect(deriveChallengeLesson(report(), spec, { workdir })).toBeUndefined();
    expect(
      deriveChallengeLesson(
        report({
          outcome: "success",
          success: true,
          iterations: [
            {
              iteration: 0,
              agent: { ok: true, stopReason: "completed" },
              evaluations: [passed("check")],
              satisfied: true,
              reason: "all checks passed",
              durationMs: 1,
              changed: true,
              changedFiles: ["answer.txt"],
              warnings: [],
            },
          ],
        }),
        spec,
        { workdir },
      ),
    ).toBeUndefined();
    expect(deriveChallengeLesson(report({ outcome: "preflight-failed" }), spec, { workdir })).toBeUndefined();
  });

  it("ignores the evaluator alias when fingerprinting a check", () => {
    const aliased = parseSpec({
      name: "checks",
      requirements: "do the thing",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "renamed", options: { command: "true" } }],
    });
    expect(evaluatorShape(aliased.evaluators[0]!)).toBe(evaluatorShape(spec.evaluators[0]!));
  });
});

describe("lessons log", () => {
  const stored = (text: string, runId = "run-past"): ChallengeLesson => ({
    failureClass: "baseline-vacuous",
    runId,
    text,
    subjects: [{ kind: "check", name: "check", shape: evaluatorShape(checkSpec("true").evaluators[0]!) }],
  });

  it("appends a lesson and does not repeat the same run", () => {
    const lesson = stored("EXACT LESSON SENTENCE");
    expect(readLessons(workdir)).toBeNull();
    recordLesson(workdir, lesson);
    recordLesson(workdir, lesson);
    const file = readLessons(workdir);
    expect(file?.kind).toBe("loopgen.lessons");
    expect(file?.lessons).toEqual([lesson]);
    expect(existsSync(`${lessonsPath(workdir)}.tmp`)).toBe(false);
  });

  it("keeps an earlier lesson when a later one is appended", () => {
    recordLesson(workdir, stored("first", "run-a"));
    recordLesson(workdir, stored("second", "run-b"));
    expect(readLessons(workdir)?.lessons.map((l) => l.runId)).toEqual(["run-a", "run-b"]);
  });

  it("refuses to overwrite an unreadable log", () => {
    mkdirSync(path.join(workdir, ".loopgen"), { recursive: true });
    writeFileSync(lessonsPath(workdir), "{");
    expect(() => recordLesson(workdir, stored("x"))).toThrow(LessonWriteError);
    expect(readFileSync(lessonsPath(workdir), "utf8")).toBe("{");
  });

  it("refuses to guess when the log cannot be parsed", () => {
    mkdirSync(path.join(workdir, ".loopgen"), { recursive: true });
    writeFileSync(lessonsPath(workdir), "{");
    expect(() => readLessons(workdir)).toThrow(LessonReadError);
  });
});

describe("lint cites the stored lesson", () => {
  const green = (as = "check", command = "true") =>
    parseSpec({
      name: "later",
      requirements: "same checks",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as, options: { command } }],
      limits: { maxIterations: 1 },
    });

  it("prints the past run id and the lesson text from the artifact", () => {
    const text = "EXACT LESSON SENTENCE FROM THE ARTIFACT";
    recordLesson(workdir, {
      failureClass: "baseline-vacuous",
      runId: "run-past",
      text,
      subjects: [{ kind: "check", name: "check", shape: evaluatorShape(green().evaluators[0]!) }],
    });

    const findings = lintSpec(green("renamed"), { workdir });
    const hit = findings.find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.severity).toBe("warn");
    expect(hit?.message).toBe(`run run-past: ${text}`);
  });

  it("does not cite a lesson when the checks differ", () => {
    recordLesson(workdir, {
      failureClass: "baseline-vacuous",
      runId: "run-past",
      text: "already green",
      subjects: [{ kind: "check", name: "check", shape: evaluatorShape(green().evaluators[0]!) }],
    });
    const findings = lintSpec(green("check", "false"), { workdir });
    expect(findings.map((f) => f.ruleId)).not.toContain("SPEC-PRIOR-LESSON");
  });

  it("cites a check lesson when the later spec still contains those checks", () => {
    const shape = evaluatorShape(green().evaluators[0]!);
    const lesson: ChallengeLesson = {
      failureClass: "vacuous-success",
      runId: "run-past",
      text: "no files changed: check.",
      subjects: [{ kind: "check", name: "check", shape }],
    };
    const later = parseSpec({
      name: "later",
      requirements: "same checks plus one",
      driver: { uses: "mock" },
      evaluators: [
        { uses: "command", as: "check", options: { command: "true" } },
        { uses: "command", as: "other", options: { command: "false" } },
      ],
    });
    expect(matchPriorLessons(later, workdir, undefined, [lesson])).toEqual([lesson]);

    const subset = parseSpec({
      name: "later",
      requirements: "dropped the vacuous check",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "other", options: { command: "false" } }],
    });
    expect(matchPriorLessons(subset, workdir, undefined, [lesson])).toEqual([]);
  });

  it("cites a spec-tamper lesson only for that spec file", () => {
    const lesson: ChallengeLesson = {
      failureClass: "spec-tampered",
      runId: "run-spec",
      text: "Spec file was modified during the run: my.loop.yaml.",
      subjects: [{ kind: "file", name: "my.loop.yaml", shape: "my.loop.yaml" }],
    };
    const spec = green();
    const file = path.join(workdir, "my.loop.yaml");
    expect(matchPriorLessons(spec, workdir, file, [lesson])).toEqual([lesson]);
    expect(matchPriorLessons(spec, workdir, path.join(workdir, "other.loop.yaml"), [lesson])).toEqual([]);
    expect(matchPriorLessons(spec, workdir, undefined, [lesson])).toEqual([]);
  });

  it("cites an evaluator-tamper lesson when the later spec names that file", () => {
    const lesson: ChallengeLesson = {
      failureClass: "evaluator-tampered",
      runId: "run-eval",
      text: "Evaluator file was modified during the run: test/c_test.rb.",
      subjects: [{ kind: "file", name: "test/c_test.rb", shape: "test/c_test.rb" }],
    };
    const namesIt = parseSpec({
      name: "later",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "c", options: { command: "true test/c_test.rb" } }],
    });
    const guardsDir = parseSpec({
      name: "later",
      requirements: "x",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" }, guard: ["test"] }],
    });
    const unrelated = green();
    expect(matchPriorLessons(namesIt, workdir, undefined, [lesson])).toEqual([lesson]);
    expect(matchPriorLessons(guardsDir, workdir, undefined, [lesson])).toEqual([lesson]);
    expect(matchPriorLessons(unrelated, workdir, undefined, [lesson])).toEqual([]);
  });

  it("warns when the lessons log is unreadable and still returns", () => {
    mkdirSync(path.join(workdir, ".loopgen"), { recursive: true });
    writeFileSync(lessonsPath(workdir), "{");
    const findings = lintSpec(green(), { workdir });
    const hit = findings.find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.message).toMatch(/Could not read lessons/);
  });

  it("reads a lesson that exists only on the challenge packet", () => {
    const text = "PACKET ONLY LESSON";
    const lesson: ChallengeLesson = {
      failureClass: "baseline-vacuous",
      runId: "run-packet",
      text,
      subjects: [{ kind: "check", name: "check", shape: evaluatorShape(green().evaluators[0]!) }],
    };
    mkdirSync(path.join(workdir, ".loopgen"), { recursive: true });
    writeFileSync(
      challengePacketPath(workdir),
      `${JSON.stringify({ kind: "loopgen.challenge", version: 1, lesson }, null, 2)}\n`,
    );
    expect(loadWorkspaceLessons(workdir)).toEqual([lesson]);
    const hit = lintSpec(green(), { workdir }).find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.message).toBe(`run run-packet: ${text}`);
  });
});

describe("lesson on the run", () => {
  it("puts a baseline lesson on the packet and preflight of the next spec cites that run", async () => {
    const spec = parseSpec({
      name: "already-green",
      requirements: "the checks must start red",
      driver: { uses: "mock", options: { steps: [{ summary: "should not run" }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: "true" } }],
      limits: { maxIterations: 2 },
    });
    const first = await engine().run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);
    expect(first.outcome).toBe("baseline-vacuous");
    expect(packet.lesson).toMatchObject({ failureClass: "baseline-vacuous", runId: first.runId });
    expect(readLessons(workdir)?.lessons).toEqual([packet.lesson]);

    const later = parseSpec({
      name: "again",
      requirements: "same already-green check",
      driver: { uses: "mock", options: { steps: [{ summary: "should not run" }] } },
      evaluators: [{ uses: "command", as: "renamed", options: { command: "true" } }],
      limits: { maxIterations: 2 },
    });
    const lintHit = lintSpec(later, { workdir }).find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(lintHit?.message).toBe(`run ${first.runId}: ${packet.lesson?.text}`);

    const pf = workspacePreflight(later, workdir);
    expect(pf.ok).toBe(true);
    expect(pf.warnings?.join("\n")).toContain(first.runId);
    expect(pf.warnings?.join("\n")).toContain(packet.lesson?.text);

    const second = await engine().run(later, { baseDir: workdir });
    expect(second.outcome).toBe("baseline-vacuous");
    expect(second.preflight?.ok).toBe(true);
    expect(second.preflight?.warnings?.join("\n")).toContain(first.runId);
    expect(second.preflight?.warnings?.join("\n")).toContain(packet.lesson?.text);
    expect(second.iterations).toHaveLength(0);
  });

  it("keeps the lesson after a later run overwrites the challenge packet", async () => {
    const vacuous = parseSpec({
      name: "already-green",
      requirements: "the checks must start red",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "check", options: { command: "true" } }],
      limits: { maxIterations: 1 },
    });
    const first = await engine().run(vacuous, { baseDir: workdir });
    const text = readPacket(workdir).lesson?.text;
    expect(text).toBeTruthy();

    const real = parseSpec({
      name: "real-work",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "answer", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const second = await engine().run(real, { baseDir: workdir });
    const packet = readPacket(workdir);
    expect(second.outcome).toBe("success");
    expect(packet.runId).toBe(second.runId);
    expect(packet.lesson).toBeUndefined();
    expect(second.changedFiles ?? []).not.toContain(".loopgen/lessons.json");
    expect(second.changedFiles ?? []).not.toContain(".loopgen/challenge.json");

    const hit = lintSpec(vacuous, { workdir }).find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.message).toBe(`run ${first.runId}: ${text}`);
  });

  it("records a spec-tamper lesson and lint of that spec file cites the run", async () => {
    const specFile = path.join(workdir, "my.loop.yaml");
    writeFileSync(specFile, "original: true\n");
    const spec = parseSpec({
      name: "tamper",
      requirements: "do not edit the spec",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "my.loop.yaml": "tampered: true\n", "x.txt": "1" } }] },
      },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir, specFile });
    const packet = readPacket(workdir);
    expect(report.outcome).toBe("spec-tampered");
    expect(packet.lesson).toMatchObject({
      failureClass: "spec-tampered",
      runId: report.runId,
      subjects: [{ kind: "file", name: "my.loop.yaml", shape: "my.loop.yaml" }],
    });

    writeFileSync(
      specFile,
      "name: tamper\nrequirements: do not edit the spec\ndriver: { uses: mock }\nevaluators: [{ uses: command, as: c, options: { command: 'true' } }]\n",
    );
    const hit = lintPath(specFile).findings.find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.message).toBe(`run ${report.runId}: ${packet.lesson?.text}`);

    const other = path.join(workdir, "other.loop.yaml");
    writeFileSync(other, readFileSync(specFile, "utf8"));
    expect(lintPath(other).findings.map((f) => f.ruleId)).not.toContain("SPEC-PRIOR-LESSON");
  });

  it("records an evaluator-tamper lesson and a later spec that names the file cites the run", async () => {
    mkdirSync(path.join(workdir, "test"), { recursive: true });
    writeFileSync(path.join(workdir, "test", "c_test.rb"), "original\n");
    const spec = parseSpec({
      name: "etamper",
      requirements: "do not edit the check",
      driver: {
        uses: "mock",
        options: { steps: [{ files: { "test/c_test.rb": "tampered\n", "x.txt": "1" } }] },
      },
      evaluators: [{ uses: "command", as: "c", options: { command: "true test/c_test.rb" } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    const packet = readPacket(workdir);
    expect(report.outcome).toBe("evaluator-tampered");
    expect(packet.lesson).toMatchObject({
      failureClass: "evaluator-tampered",
      runId: report.runId,
      subjects: [{ kind: "file", name: "test/c_test.rb", shape: "test/c_test.rb" }],
    });
    expect(report.changedFiles ?? []).not.toContain(".loopgen/lessons.json");

    const later = parseSpec({
      name: "later",
      requirements: "same guarded file",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "c", options: { command: "npm test test/c_test.rb" } }],
    });
    const hit = lintSpec(later, { workdir }).find((f) => f.ruleId === "SPEC-PRIOR-LESSON");
    expect(hit?.message).toBe(`run ${report.runId}: ${packet.lesson?.text}`);

    const different = parseSpec({
      name: "later",
      requirements: "different check",
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
    });
    expect(lintSpec(different, { workdir }).map((f) => f.ruleId)).not.toContain("SPEC-PRIOR-LESSON");
  });

  it("does not treat the lessons log as agent work", async () => {
    initGitRepo(workdir);
    mkdirSync(path.join(workdir, ".loopgen"), { recursive: true });
    writeFileSync(lessonsPath(workdir), '{"kind":"loopgen.lessons","version":1,"lessons":[]}\n');
    const spec = parseSpec({
      name: "work",
      requirements: "write 42",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } }],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.changedFiles ?? []).toContain("answer.txt");
    expect(report.changedFiles ?? []).not.toContain(".loopgen/lessons.json");
    expect(report.changedFiles ?? []).not.toContain(".loopgen/challenge.json");
    expect(report.changedFiles ?? []).not.toContain(".loopgen/path-index.json");
    expect(readPacket(workdir).lesson).toBeUndefined();
  });
});
