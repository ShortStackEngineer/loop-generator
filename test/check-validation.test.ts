import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ChecksManifestError,
  classifyCheckExecution,
  classifyClaim,
  classifyCounterexample,
  classifyOutcome,
  checkValidationExitCode,
  controlPassed,
  loadChecksFile,
  parseChecksManifest,
  runCheckValidation,
  type CheckRunResult,
  type ChecksManifest,
  type CounterexampleReport,
} from "../src/index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopgen-cv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCandidate(name: string, value: string): void {
  mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, name, "answer.txt"), value);
}

const ANSWER_CMD =
  "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8').trim() === '42' ? 0 : 1)\"";

function rawManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "answer-contract",
    goal: "Return the correct answer without losing the user's intent.",
    assumptions: ["The input domain is the supplied fixtures."],
    gaps: ["Production behavior is unobserved."],
    claims: [{ id: "correct", description: "The answer is 42", checks: ["answer"] }],
    checks: [{ id: "answer", command: ANSWER_CMD, timeoutMs: 2000 }],
    control: { dir: "good" },
    counterexamples: [{ id: "wrong-answer", claim: "correct", dir: "bad" }],
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): ChecksManifest {
  return parseChecksManifest(rawManifest(over));
}

function seedGoodBad(): void {
  writeCandidate("good", "42");
  writeCandidate("bad", "41");
}

describe("checks manifest schema", () => {
  it("applies defaults for assumptions, gaps, timeoutMs, and rejectExitCodes", () => {
    const m = parseChecksManifest({
      version: 1,
      name: "n",
      goal: "g",
      claims: [{ id: "c", description: "d", checks: ["k"] }],
      checks: [{ id: "k", command: "true" }],
      control: { dir: "good" },
      counterexamples: [{ id: "x", claim: "c", dir: "bad" }],
    });
    expect(m.assumptions).toEqual([]);
    expect(m.gaps).toEqual([]);
    expect(m.checks[0]?.timeoutMs).toBe(10_000);
    expect(m.checks[0]?.rejectExitCodes).toEqual([1]);
  });

  it("rejects empty collections and empty required strings", () => {
    expect(() => parseChecksManifest(rawManifest({ claims: [] }))).toThrow(ChecksManifestError);
    expect(() => parseChecksManifest(rawManifest({ checks: [] }))).toThrow(ChecksManifestError);
    expect(() => parseChecksManifest(rawManifest({ counterexamples: [] }))).toThrow(ChecksManifestError);
    expect(() => parseChecksManifest(rawManifest({ name: "" }))).toThrow(/name/);
    expect(() => parseChecksManifest(rawManifest({ goal: "" }))).toThrow(/goal/);
    expect(() =>
      parseChecksManifest(rawManifest({ claims: [{ id: "", description: "d", checks: ["answer"] }] })),
    ).toThrow(/id/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ claims: [{ id: "c", description: "d", checks: [] }] }),
      ),
    ).toThrow(/at least one check|nonempty/i);
    expect(() => parseChecksManifest(rawManifest({ control: { dir: "" } }))).toThrow(/dir/);
    expect(() =>
      parseChecksManifest(rawManifest({ checks: [{ id: "answer", command: "" }] })),
    ).toThrow(/command/);
  });

  it("rejects duplicate IDs within each collection", () => {
    expect(() =>
      parseChecksManifest(
        rawManifest({
          checks: [
            { id: "answer", command: "true" },
            { id: "answer", command: "true" },
          ],
        }),
      ),
    ).toThrow(/duplicate check id/);
    expect(() =>
      parseChecksManifest(
        rawManifest({
          claims: [
            { id: "correct", description: "a", checks: ["answer"] },
            { id: "correct", description: "b", checks: ["answer"] },
          ],
        }),
      ),
    ).toThrow(/duplicate claim id/);
    expect(() =>
      parseChecksManifest(
        rawManifest({
          counterexamples: [
            { id: "wrong-answer", claim: "correct", dir: "bad" },
            { id: "wrong-answer", claim: "correct", dir: "bad" },
          ],
        }),
      ),
    ).toThrow(/duplicate counterexample id/);
  });

  it("rejects unknown check/claim refs and duplicate check refs", () => {
    expect(() =>
      parseChecksManifest(
        rawManifest({ claims: [{ id: "correct", description: "d", checks: ["missing"] }] }),
      ),
    ).toThrow(/unknown check/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ counterexamples: [{ id: "x", claim: "missing", dir: "bad" }] }),
      ),
    ).toThrow(/unknown claim/);
    expect(() =>
      parseChecksManifest(
        rawManifest({
          claims: [{ id: "correct", description: "d", checks: ["answer", "answer"] }],
        }),
      ),
    ).toThrow(/duplicate check ref/);
  });

  it("rejects invalid timeouts and rejectExitCodes", () => {
    expect(() =>
      parseChecksManifest(rawManifest({ checks: [{ id: "answer", command: "true", timeoutMs: 0 }] })),
    ).toThrow(/timeoutMs/);
    expect(() =>
      parseChecksManifest(rawManifest({ checks: [{ id: "answer", command: "true", timeoutMs: -5 }] })),
    ).toThrow(/timeoutMs/);
    expect(() =>
      parseChecksManifest(rawManifest({ checks: [{ id: "answer", command: "true", timeoutMs: 1.5 }] })),
    ).toThrow(/timeoutMs/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ checks: [{ id: "answer", command: "true", rejectExitCodes: [] }] }),
      ),
    ).toThrow(/rejectExitCodes/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ checks: [{ id: "answer", command: "true", rejectExitCodes: [0] }] }),
      ),
    ).toThrow(/rejectExitCodes/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ checks: [{ id: "answer", command: "true", rejectExitCodes: [126] }] }),
      ),
    ).toThrow(/rejectExitCodes/);
    expect(() =>
      parseChecksManifest(
        rawManifest({ checks: [{ id: "answer", command: "true", rejectExitCodes: [1.2] }] }),
      ),
    ).toThrow(/rejectExitCodes/);
  });

  it("requires version 1", () => {
    expect(() => parseChecksManifest(rawManifest({ version: 2 }))).toThrow(/version/);
  });
});

describe("aggregation", () => {
  const pass: CheckRunResult = { check: "a", status: "passed", exitCode: 0, feedback: "ok" };
  const reject: CheckRunResult = { check: "a", status: "rejected", exitCode: 1, feedback: "no" };
  const err: CheckRunResult = { check: "a", status: "error", exitCode: 2, feedback: "boom" };
  const unrelatedReject: CheckRunResult = {
    check: "other",
    status: "rejected",
    exitCode: 1,
    feedback: "no",
  };

  it("classifies exit codes, timeouts, and aborts", () => {
    expect(classifyCheckExecution({ code: 0, timedOut: false, rejectExitCodes: [1] })).toBe("passed");
    expect(classifyCheckExecution({ code: 1, timedOut: false, rejectExitCodes: [1] })).toBe("rejected");
    expect(classifyCheckExecution({ code: 2, timedOut: false, rejectExitCodes: [1] })).toBe("error");
    expect(classifyCheckExecution({ code: 2, timedOut: false, rejectExitCodes: [1, 2] })).toBe("rejected");
    expect(classifyCheckExecution({ code: 1, timedOut: true, rejectExitCodes: [1] })).toBe("error");
    expect(classifyCheckExecution({ code: 0, timedOut: false, aborted: true, rejectExitCodes: [1] })).toBe(
      "error",
    );
    expect(classifyCheckExecution({ code: null, timedOut: false, rejectExitCodes: [1] })).toBe("error");
  });

  it("never counts errors as caught, and ignores unmapped rejects", () => {
    expect(classifyCounterexample([reject], ["a"])).toBe("caught");
    expect(classifyCounterexample([pass], ["a"])).toBe("escaped");
    expect(classifyCounterexample([reject, err], ["a"])).toBe("error");
    expect(classifyCounterexample([pass, unrelatedReject], ["a"])).toBe("escaped");
    expect(classifyCounterexample([pass, unrelatedReject], ["a", "other"])).toBe("caught");
  });

  it("validates a claim only with ≥1 mapped counterexample, all caught", () => {
    const caught: CounterexampleReport = {
      id: "x",
      claim: "c",
      status: "caught",
      checks: [reject],
    };
    const escaped: CounterexampleReport = {
      id: "y",
      claim: "c",
      status: "escaped",
      checks: [pass],
    };
    const errored: CounterexampleReport = {
      id: "z",
      claim: "c",
      status: "error",
      checks: [err],
    };
    expect(classifyClaim("c", [])).toEqual({ status: "gap" });
    expect(classifyClaim("c", [caught])).toEqual({ status: "validated", caught: ["x"] });
    expect(classifyClaim("c", [caught, escaped])).toEqual({
      status: "gap",
      caught: ["x"],
      escaped: ["y"],
    });
    expect(classifyClaim("c", [caught, errored])).toEqual({
      status: "error",
      caught: ["x"],
    });
    expect(classifyClaim("other", [caught])).toEqual({ status: "gap" });
  });

  it("lets execution errors take precedence over gaps; control failure is error", () => {
    expect(controlPassed([pass])).toBe(true);
    expect(controlPassed([reject])).toBe(false);
    expect(controlPassed([err])).toBe(false);

    const gapClaim = { id: "c", description: "d", status: "gap" as const };
    const okClaim = { id: "c", description: "d", status: "validated" as const };
    const errClaim = { id: "c", description: "d", status: "error" as const };
    const escapedCe: CounterexampleReport = {
      id: "x",
      claim: "c",
      status: "escaped",
      checks: [pass],
    };
    const errCe: CounterexampleReport = { id: "x", claim: "c", status: "error", checks: [err] };

    expect(classifyOutcome([reject], [], [gapClaim])).toBe("error");
    expect(classifyOutcome([pass], [errCe], [errClaim])).toBe("error");
    expect(classifyOutcome([pass], [escapedCe], [gapClaim])).toBe("gaps");
    expect(classifyOutcome([pass], [], [okClaim])).toBe("validated");
  });

  it("maps outcomes to CLI exit codes", () => {
    expect(checkValidationExitCode("validated")).toBe(0);
    expect(checkValidationExitCode("gaps")).toBe(1);
    expect(checkValidationExitCode("error")).toBe(2);
  });
});

describe("runCheckValidation", () => {
  it("validates a discriminating check and preserves claim context and explicit gaps", async () => {
    seedGoodBad();
    const spec = parsed();
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report).toMatchObject({
      name: spec.name,
      goal: spec.goal,
      assumptions: spec.assumptions,
      gaps: spec.gaps,
      outcome: "validated",
    });
    expect(report.control[0]).toMatchObject({ check: "answer", status: "passed", exitCode: 0 });
    expect(report.counterexamples[0]).toMatchObject({
      id: "wrong-answer",
      claim: "correct",
      status: "caught",
    });
    expect(report.claims[0]).toMatchObject({
      id: "correct",
      description: "The answer is 42",
      status: "validated",
      caught: ["wrong-answer"],
    });
    expect(readFileSync(path.join(dir, "good/answer.txt"), "utf8")).toBe("42");
    expect(readFileSync(path.join(dir, "bad/answer.txt"), "utf8")).toBe("41");
  });

  it("reports an escaped counterexample when a check accepts everything", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [{ id: "answer", command: "node -e \"process.exit(0)\"", timeoutMs: 2000 }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("gaps");
    expect(report.counterexamples[0]?.status).toBe("escaped");
    expect(report.claims[0]?.status).toBe("gap");
    expect(report.gaps).toEqual(["Production behavior is unobserved."]);
  });

  it("does not run counterexamples when the control is rejected", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [{ id: "answer", command: "node -e \"process.exit(1)\"", timeoutMs: 2000 }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.status).toBe("rejected");
    expect(report.counterexamples).toEqual([]);
    expect(report.claims.every((c) => c.status === "error")).toBe(true);
  });

  it("classifies harness failure on the control as error and skips counterexamples", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [{ id: "answer", command: "node -e \"process.exit(2)\"", timeoutMs: 2000 }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.status).toBe("error");
    expect(report.counterexamples).toEqual([]);
  });

  it("does not count a crashing faulty candidate as caught", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [
        {
          id: "answer",
          command:
            "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8').trim() === '42' ? 0 : 2)\"",
          timeoutMs: 2000,
        },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.counterexamples[0]?.status).toBe("error");
    expect(report.claims[0]?.status).toBe("error");
  });

  it("reports timeout as an error, never evidence of fault detection", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [
        {
          id: "answer",
          command: "node -e \"setTimeout(() => {}, 500)\"",
          timeoutMs: 100,
        },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.status).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/TIMED OUT/);
    expect(report.counterexamples).toEqual([]);
  });

  it("keeps a claim without a counterexample uncovered (gap)", async () => {
    seedGoodBad();
    const spec = parsed({
      claims: [
        { id: "correct", description: "The answer is 42", checks: ["answer"] },
        { id: "latency", description: "Fast enough", checks: ["answer"] },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("gaps");
    expect(report.claims.find((c) => c.id === "correct")?.status).toBe("validated");
    expect(report.claims.find((c) => c.id === "latency")?.status).toBe("gap");
  });

  it("does not let an unrelated check take credit for the mapped claim", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [
        { id: "answer", command: "node -e \"process.exit(0)\"", timeoutMs: 2000 },
        { id: "unrelated", command: ANSWER_CMD, timeoutMs: 2000 },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("gaps");
    expect(report.counterexamples[0]?.status).toBe("escaped");
    const unrelated = report.counterexamples[0]?.checks.find((c) => c.check === "unrelated");
    expect(unrelated?.status).toBe("rejected");
  });

  it("copies fresh fixtures for each check and leaves originals untouched", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [
        {
          id: "mutator",
          command: "node -e \"require('fs').writeFileSync('answer.txt','changed')\"",
          timeoutMs: 2000,
        },
        { id: "answer", command: ANSWER_CMD, timeoutMs: 2000 },
      ],
      claims: [{ id: "correct", description: "The answer is 42", checks: ["answer"] }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("validated");
    expect(readFileSync(path.join(dir, "good/answer.txt"), "utf8")).toBe("42");
    expect(readFileSync(path.join(dir, "bad/answer.txt"), "utf8")).toBe("41");
  });

  it("treats a declared reject code other than 1 as a catch", async () => {
    seedGoodBad();
    const spec = parsed({
      checks: [
        {
          id: "answer",
          command:
            "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8').trim() === '42' ? 0 : 2)\"",
          timeoutMs: 2000,
          rejectExitCodes: [2],
        },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("validated");
    expect(report.counterexamples[0]?.status).toBe("caught");
    expect(report.counterexamples[0]?.checks[0]).toMatchObject({ status: "rejected", exitCode: 2 });
  });

  it("resolves fixture dirs relative to baseDir, not process.cwd()", async () => {
    seedGoodBad();
    const spec = parsed();
    const originalCwd = process.cwd();
    expect(dir).not.toBe(originalCwd);
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("validated");
    expect(process.cwd()).toBe(originalCwd);
  });

  it("loads YAML from disk and resolves dirs beside the manifest", async () => {
    seedGoodBad();
    const file = path.join(dir, "contract.checks.yaml");
    writeFileSync(
      file,
      [
        "version: 1",
        "name: from-yaml",
        "goal: g",
        "claims:",
        "  - id: correct",
        "    description: The answer is 42",
        "    checks: [answer]",
        "checks:",
        "  - id: answer",
        `    command: ${JSON.stringify(ANSWER_CMD)}`,
        "    timeoutMs: 2000",
        "control: { dir: good }",
        "counterexamples:",
        "  - id: wrong-answer",
        "    claim: correct",
        "    dir: bad",
      ].join("\n"),
    );
    const loaded = loadChecksFile(file);
    expect(loaded.baseDir).toBe(dir);
    const originalCwd = process.cwd();
    const report = await runCheckValidation(loaded.manifest, { baseDir: loaded.baseDir });
    expect(report.outcome).toBe("validated");
    expect(report.name).toBe("from-yaml");
    expect(process.cwd()).toBe(originalCwd);
  });

  it("runs the shipped strong and weak offline examples from disk", async () => {
    const examples = path.resolve("examples/check-validation");
    const strong = loadChecksFile(path.join(examples, "strong.checks.yaml"));
    const weak = loadChecksFile(path.join(examples, "weak.checks.yaml"));
    const originalCwd = process.cwd();
    const strongReport = await runCheckValidation(strong.manifest, { baseDir: strong.baseDir });
    const weakReport = await runCheckValidation(weak.manifest, { baseDir: weak.baseDir });
    expect(strongReport.outcome).toBe("validated");
    expect(strongReport.counterexamples[0]?.status).toBe("caught");
    expect(weakReport.outcome).toBe("gaps");
    expect(weakReport.counterexamples[0]?.status).toBe("escaped");
    expect(process.cwd()).toBe(originalCwd);
  });

  it("errors on a missing fixture directory without running later stages", async () => {
    writeCandidate("bad", "41");
    const spec = parsed();
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.status).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/missing fixture directory/);
    expect(report.counterexamples).toEqual([]);
  });

  it("rejects a fixture path that is a file, not a directory", async () => {
    writeFileSync(path.join(dir, "good"), "not-a-dir");
    writeCandidate("bad", "41");
    const spec = parsed();
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/not a directory/);
    expect(report.counterexamples).toEqual([]);
  });

  it("rejects a symlinked fixture root", async () => {
    writeCandidate("real-good", "42");
    writeCandidate("bad", "41");
    symlinkSync(path.join(dir, "real-good"), path.join(dir, "good"));
    const spec = parsed();
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/symlink/);
    expect(report.counterexamples).toEqual([]);
  });

  it("rejects nested symlinks rather than mutating their external targets", async () => {
    seedGoodBad();
    const external = path.join(dir, "outside.txt");
    writeFileSync(external, "untouched");
    symlinkSync(external, path.join(dir, "good/link.txt"));
    const spec = parsed({
      checks: [
        {
          id: "answer",
          command: "node -e \"require('fs').writeFileSync('link.txt','modified')\"",
          timeoutMs: 2000,
        },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/symlink/);
    expect(readFileSync(external, "utf8")).toBe("untouched");
    expect(report.counterexamples).toEqual([]);
  });

  it("rejects special files (fifo) before execution", async () => {
    seedGoodBad();
    const fifo = path.join(dir, "good", "pipe");
    const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(mk.status, mk.stderr).toBe(0);
    const spec = parsed();
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.feedback).toMatch(/fifo|special file/i);
    expect(report.counterexamples).toEqual([]);
  });

  it("aborts in-flight work, reports error, and removes its temp copy", async () => {
    seedGoodBad();
    const cwdRecord = path.join(dir, "check-cwd.txt");
    writeFileSync(path.join(dir, "good", "cleanup-check.cjs"),
      `require('fs').writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd()); setTimeout(() => {}, 8000);`);
    const spec = parsed({
      checks: [{ id: "answer", command: "node cleanup-check.cjs", timeoutMs: 15_000 }],
    });
    const ac = new AbortController();
    const running = runCheckValidation(spec, { baseDir: dir, signal: ac.signal });
    const deadline = Date.now() + 3000;
    while (!existsSync(cwdRecord) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    ac.abort();
    const report = await running;
    expect(report.outcome).toBe("error");
    expect(report.control[0]?.status).toBe("error");
    expect(report.counterexamples).toEqual([]);
    expect(existsSync(cwdRecord), "the check started before cancellation").toBe(true);
    const copiedDir = readFileSync(cwdRecord, "utf8");
    expect(existsSync(path.dirname(copiedDir)), "this check's temporary copy was removed").toBe(false);
  });

  it("lets a counterexample fixture error take precedence over an escaped sibling claim", async () => {
    seedGoodBad();
    mkdirSync(path.join(dir, "also-bad"));
    writeFileSync(path.join(dir, "also-bad", "answer.txt"), "40");
    const spec = parsed({
      claims: [
        { id: "correct", description: "The answer is 42", checks: ["answer"] },
        { id: "other", description: "Also covered", checks: ["answer"] },
      ],
      checks: [{ id: "answer", command: "node -e \"process.exit(0)\"", timeoutMs: 2000 }],
      counterexamples: [
        { id: "wrong-answer", claim: "correct", dir: "bad" },
        { id: "broken", claim: "other", dir: "missing-dir" },
      ],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.outcome).toBe("error");
    expect(report.counterexamples.find((c) => c.id === "wrong-answer")?.status).toBe("escaped");
    expect(report.counterexamples.find((c) => c.id === "broken")?.status).toBe("error");
    expect(report.claims.find((c) => c.id === "correct")?.status).toBe("gap");
    expect(report.claims.find((c) => c.id === "other")?.status).toBe("error");
  });
});
