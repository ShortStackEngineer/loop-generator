import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Black-box contract: exercise the shipped CLI and actual shell checks. Build
// before running this suite. No implementation imports or mocked subprocesses.
const cli = path.resolve("dist/cli/index.js");
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "loopgen-check-acceptance-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function candidate(name: string, value: string) {
  mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, name, "answer.txt"), value);
}

function fixture() {
  candidate("good", "42");
  candidate("bad", "41");
  return {
    version: 1, name: "answer-contract", goal: "Return the correct answer without losing the user's intent.",
    assumptions: ["The input domain is the supplied fixtures."], gaps: ["Production behavior is unobserved."],
    claims: [{ id: "correct", description: "The answer is 42", checks: ["answer"] }],
    checks: [{ id: "answer", command: "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8') === '42' ? 0 : 1)\"", timeoutMs: 1000 }],
    control: { dir: "good" },
    counterexamples: [{ id: "wrong-answer", claim: "correct", dir: "bad" }],
  };
}

function run(spec: unknown) {
  const file = path.join(root, "contract.checks.yaml");
  const reportFile = path.join(root, "report.json");
  writeFileSync(file, JSON.stringify(spec));
  // Deliberately run elsewhere: fixture paths must resolve beside the manifest.
  const result = spawnSync(process.execPath, [cli, "validate-checks", file, "--report", reportFile], {
    cwd: tmpdir(), encoding: "utf8", timeout: 15000,
  });
  let report: any;
  try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { /* absent on invalid input */ }
  return { code: result.status, output: result.stdout + result.stderr, report };
}

describe("validate-checks CLI acceptance", () => {
  it("rejects a real wrong implementation and preserves claim-to-evidence context", () => {
    const spec = fixture();
    const result = run(spec);
    expect(result.code, result.output).toBe(0);
    expect(result.report).toMatchObject({ outcome: "validated", goal: spec.goal, assumptions: spec.assumptions, gaps: spec.gaps });
    expect(result.report.control[0]).toMatchObject({ check: "answer", status: "passed", exitCode: 0 });
    expect(result.report.counterexamples[0]).toMatchObject({ id: "wrong-answer", claim: "correct", status: "caught" });
    expect(result.report.claims[0]).toMatchObject({ id: "correct", description: "The answer is 42", status: "validated" });
    expect(readFileSync(path.join(root, "good/answer.txt"), "utf8")).toBe("42");
    expect(readFileSync(path.join(root, "bad/answer.txt"), "utf8")).toBe("41");
  });

  it("reports an escaped counterexample when a check accepts everything", () => {
    const spec = fixture(); spec.checks[0]!.command = "node -e \"process.exit(0)\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(1);
    expect(result.report?.outcome).toBe("gaps");
    expect(result.report.counterexamples[0].status).toBe("escaped");
    expect(result.report.claims[0].status).toBe("gap");
  });

  it("does not reward a check that rejects the known-good control", () => {
    const spec = fixture(); spec.checks[0]!.command = "node -e \"process.exit(1)\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(result.report?.outcome).toBe("error");
    expect(result.report.control[0].status).toBe("rejected");
    expect(result.report.counterexamples).toEqual([]);
  });

  it.each(["node -e \"process.exit(2)\"", "loopgen_missing_checker_binary_928451"])("classifies harness failure as error: %s", command => {
    const spec = fixture(); spec.checks[0]!.command = command;
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(result.report?.outcome).toBe("error");
    expect(result.report.control[0].status).toBe("error");
  });

  it("does not count a crashing faulty candidate as caught", () => {
    const spec = fixture();
    spec.checks[0]!.command = "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8') === '42' ? 0 : 2)\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(result.report?.counterexamples[0].status).toBe("error");
  });

  it("reports timeout as an error, never evidence of fault detection", () => {
    const spec = fixture(); spec.checks[0]!.timeoutMs = 100;
    spec.checks[0]!.command = "node -e \"setTimeout(() => {}, 500)\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(result.report?.control[0].status).toBe("error");
  });

  it("keeps a claim without a counterexample visibly uncovered", () => {
    const spec = fixture(); spec.claims.push({ id: "latency", description: "Fast enough", checks: ["answer"] });
    const result = run(spec);
    expect(result.code, result.output).toBe(1);
    expect(result.report?.claims.find((c: any) => c.id === "latency").status).toBe("gap");
  });

  it("does not let an unrelated check take credit for the mapped claim", () => {
    const spec = fixture();
    spec.checks.push({ ...spec.checks[0]!, id: "unrelated" });
    spec.checks[0]!.command = "node -e \"process.exit(0)\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(1);
    expect(result.report?.counterexamples[0].status).toBe("escaped");
  });

  it("copies fresh fixtures for each check and leaves originals untouched", () => {
    const spec = fixture();
    spec.checks.unshift({ id: "mutator", command: "node -e \"require('fs').writeFileSync('answer.txt','changed')\"", timeoutMs: 1000 });
    const result = run(spec);
    expect(result.code, result.output).toBe(0);
    expect(readFileSync(path.join(root, "good/answer.txt"), "utf8")).toBe("42");
    expect(readFileSync(path.join(root, "bad/answer.txt"), "utf8")).toBe("41");
  });

  it.each(["duplicate-check", "unknown-check", "unknown-claim", "empty-claims", "empty-counterexamples"])("rejects invalid references or vacuous manifests: %s", kind => {
    const spec = fixture();
    if (kind === "duplicate-check") spec.checks.push({ ...spec.checks[0]! });
    if (kind === "unknown-check") spec.claims[0]!.checks = ["missing"];
    if (kind === "unknown-claim") spec.counterexamples[0]!.claim = "missing";
    if (kind === "empty-claims") spec.claims = [];
    if (kind === "empty-counterexamples") spec.counterexamples = [];
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(result.report?.outcome).not.toBe("validated");
  });

  it("rejects symlinked fixtures rather than mutating their external targets", () => {
    const spec = fixture();
    const external = path.join(root, "outside.txt"); writeFileSync(external, "untouched");
    symlinkSync(external, path.join(root, "good/link.txt"));
    spec.checks[0]!.command = "node -e \"require('fs').writeFileSync('link.txt','modified')\"";
    const result = run(spec);
    expect(result.code, result.output).toBe(2);
    expect(readFileSync(external, "utf8")).toBe("untouched");
  });
});
