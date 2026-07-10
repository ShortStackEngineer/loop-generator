/**
 * High-ROI mutation kills for small core modules:
 * feedback.ts, exec.ts, criteria.ts, tasks/base.ts.
 * Pin exact strings / operators / buffer boundaries that Survived under the baseline.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFeedback } from "../src/core/feedback";
import { runCommand, tail } from "../src/core/exec";
import { evaluateCriteria, describeCriteria } from "../src/core/criteria";
import { languageCommands, standardEvaluators, createTaskType } from "../src/tasks/base";
import { parseSpec } from "../src/core/spec";
import type { EvaluationResult } from "../src/evaluators/types";

function er(
  name: string,
  passed: boolean,
  over: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    name,
    type: "command",
    ok: true,
    passed,
    feedback: over.feedback ?? (passed ? "ok" : "bad"),
    durationMs: 1,
    ...over,
  };
}

// ─── feedback.ts ─────────────────────────────────────────────────────────────
describe("mut: buildFeedback exact strings", () => {
  it("renders Overall PASS / NOT YET with the verdict reason", () => {
    const pass = buildFeedback([er("t", true)], { satisfied: true, reason: "all checks passed" });
    expect(pass.passed).toBe(true);
    expect(pass.reason).toBe("all checks passed");
    expect(pass.text.startsWith("Overall: PASS — all checks passed")).toBe(true);

    const fail = buildFeedback([er("t", false)], { satisfied: false, reason: "failing: t" });
    expect(fail.passed).toBe(false);
    expect(fail.text.startsWith("Overall: NOT YET — failing: t")).toBe(true);
  });

  it("uses exact section headers and failing-check formatting", () => {
    const r = er("tests", false, {
      type: "command",
      ok: false,
      error: "boom",
      score: 0.1,
      feedback: "  detail here  ",
    });
    const fb = buildFeedback([r, er("lint", true, { score: 1 })], {
      satisfied: false,
      reason: "failing: tests",
    });
    expect(fb.text).toContain("## Failing checks (fix these)");
    expect(fb.text).toContain("### tests [command] (could not run)");
    expect(fb.text).toContain("score: 0.1");
    expect(fb.text).toContain("error: boom");
    expect(fb.text).toContain("detail here");
    expect(fb.text).toContain("## Passing checks (keep these green)");
    expect(fb.text).toContain("- lint [command] (score 1)");
  });

  it("uses '(no detail)' when feedback is empty/whitespace", () => {
    const fb = buildFeedback([er("t", false, { feedback: "   " })], {
      satisfied: false,
      reason: "r",
    });
    expect(fb.text).toContain("(no detail)");
  });

  it("omits (could not run) when ok is true", () => {
    const fb = buildFeedback([er("t", false, { ok: true })], { satisfied: false, reason: "r" });
    expect(fb.text).toContain("### t [command]");
    expect(fb.text).not.toContain("(could not run)");
  });

  it("omits score/error lines when absent", () => {
    const fb = buildFeedback([er("t", false, { score: undefined, error: undefined })], {
      satisfied: false,
      reason: "r",
    });
    expect(fb.text).not.toMatch(/^score:/m);
    expect(fb.text).not.toMatch(/^error:/m);
  });

  it("omits failing section when all pass, and passing section when all fail", () => {
    const allPass = buildFeedback([er("a", true)], { satisfied: true, reason: "ok" });
    expect(allPass.text).not.toContain("## Failing checks");
    expect(allPass.text).toContain("## Passing checks (keep these green)");

    const allFail = buildFeedback([er("a", false)], { satisfied: false, reason: "r" });
    expect(allFail.text).toContain("## Failing checks (fix these)");
    expect(allFail.text).not.toContain("## Passing checks");
  });

  it("diff section uses exact header and skips empty files list", () => {
    const withFiles = buildFeedback([er("t", true)], { satisfied: true, reason: "ok" }, {
      diff: { files: ["a.ts"], patch: "@@ +1 @@" },
    });
    expect(withFiles.text).toContain("## Changes you made last iteration (1 file(s))");
    expect(withFiles.text).toContain("Diff of your last changes (truncated if large):");
    expect(withFiles.text).toContain("```diff");
    expect(withFiles.text).toContain("@@ +1 @@");
    expect(withFiles.text).toContain("```");

    // Empty files → no diff section (opts.diff.files.length is falsy).
    const empty = buildFeedback([er("t", true)], { satisfied: true, reason: "ok" }, {
      diff: { files: [] },
    });
    expect(empty.text).not.toContain("Changes you made last iteration");
  });

  it("truncate keeps head/tail with exact omitted marker and 25% head split", () => {
    // max=200 → head=50, tail=150; total content 1000 → omit 800.
    const body = "H".repeat(50) + "M".repeat(800) + "T".repeat(150);
    const fb = buildFeedback([er("t", false, { feedback: body })], { satisfied: false, reason: "r" }, {
      maxCharsPerCheck: 200,
    });
    expect(fb.text).toContain("H".repeat(50));
    expect(fb.text).toContain("T".repeat(150));
    expect(fb.text).toContain("…[800 chars omitted]…");
    // Short text is not truncated.
    const short = buildFeedback([er("t", false, { feedback: "tiny" })], { satisfied: false, reason: "r" }, {
      maxCharsPerCheck: 200,
    });
    expect(short.text).toContain("tiny");
    expect(short.text).not.toContain("chars omitted");
  });

  it("defaults maxCharsPerCheck to 4000 (DEFAULT_MAX_FEEDBACK_CHARS)", () => {
    // Under default, 3500 chars pass; under a mutant default of 0 everything truncates.
    const body = "x".repeat(3500);
    const fb = buildFeedback([er("t", false, { feedback: body })], { satisfied: false, reason: "r" });
    expect(fb.text).toContain(body);
    expect(fb.text).not.toContain("chars omitted");
  });

  it("returns evaluations array by reference identity", () => {
    const results = [er("t", true)];
    const fb = buildFeedback(results, { satisfied: true, reason: "ok" });
    expect(fb.evaluations).toBe(results);
  });
});

// ─── exec.ts ─────────────────────────────────────────────────────────────────
describe("mut: runCommand and tail", () => {
  it("rejects with exact 'aborted before start' when signal is already aborted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mut-exec-"));
    try {
      await expect(
        runCommand("echo hi", { cwd: dir, signal: AbortSignal.abort() }),
      ).rejects.toThrow("aborted before start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets timedOut true and non-success on timeout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mut-exec-"));
    try {
      const r = await runCommand("sleep 10", { cwd: dir, timeoutMs: 80 });
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeGreaterThanOrEqual(50);
      // Killed by SIGKILL → code null or non-zero depending on platform timing.
      expect(r.code === null || r.code !== 0).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures stderr separately from stdout and into combined", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mut-exec-"));
    try {
      const r = await runCommand("echo OUT; echo ERR 1>&2", { cwd: dir });
      expect(r.stdout).toContain("OUT");
      expect(r.stderr).toContain("ERR");
      expect(r.combined).toMatch(/OUT/);
      expect(r.combined).toMatch(/ERR/);
      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects maxBuffer on stdout (stops appending once length >= cap)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mut-exec-"));
    try {
      // Delayed writes so the parent sees multiple 'data' events; the
      // `stdout.length < maxBuffer` guard only bites across chunk boundaries.
      const writer = path.join(dir, "writer.mjs");
      writeFileSync(
        writer,
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 15; i++) {
    process.stdout.write("x".repeat(10));
    await sleep(15);
  }
})();
`,
      );
      const r = await runCommand(`node ${JSON.stringify(writer)}`, { cwd: dir, maxBuffer: 50 });
      expect(r.code).toBe(0);
      // Once length reaches 50, further 10-byte chunks are dropped under strict `<`.
      // A `<=` mutant would keep growing past 50+10.
      expect(r.stdout.length).toBeGreaterThanOrEqual(50);
      expect(r.stdout.length).toBeLessThanOrEqual(59); // last accepted chunk can overshoot by <10
      expect(r.stdout).toMatch(/^x+$/);
      expect(r.stdout.length).toBeLessThan(150); // full stream would be 150
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not start a timer when timeoutMs is omitted/0-ish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mut-exec-"));
    try {
      const r = await runCommand("echo fast", { cwd: dir });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tail uses exact omission marker and keeps last maxChars", () => {
    expect(tail("abcdefghij", 4)).toBe("…[6 earlier chars omitted]…\nghij");
    expect(tail("short", 100)).toBe("short");
    expect(tail("exactly5", 8)).toBe("exactly5"); // length == max → no trim (uses <=)
    expect(tail("exactly5!", 8)).toBe("…[1 earlier chars omitted]…\nxactly5!");
  });
});

// ─── criteria.ts ─────────────────────────────────────────────────────────────
describe("mut: evaluateCriteria exact reasons", () => {
  it("all-pass: empty results, all green, and failing list", () => {
    expect(evaluateCriteria({ type: "all-pass" }, [])).toEqual({
      satisfied: false,
      reason: "no evaluators were configured",
    });
    expect(evaluateCriteria({ type: "all-pass" }, [er("a", true), er("b", true)])).toEqual({
      satisfied: true,
      reason: "all checks passed",
    });
    expect(evaluateCriteria({ type: "all-pass" }, [er("a", true), er("b", false), er("c", false)])).toEqual({
      satisfied: false,
      reason: "failing: b, c",
    });
  });

  it("pass: missing, failing, and success reasons are exact", () => {
    expect(
      evaluateCriteria({ type: "pass", evaluators: ["ghost", "a"] }, [er("a", true)]),
    ).toEqual({ satisfied: false, reason: "unknown evaluator(s): ghost" });

    expect(
      evaluateCriteria({ type: "pass", evaluators: ["a", "b"] }, [er("a", false), er("b", true)]),
    ).toEqual({ satisfied: false, reason: "failing: a" });

    expect(
      evaluateCriteria({ type: "pass", evaluators: ["a", "b"] }, [er("a", true), er("b", true)]),
    ).toEqual({ satisfied: true, reason: "required checks passed: a, b" });
  });

  it("score: gte/lte/eq boundaries and reason formatting", () => {
    const scored = (n: number) => er("m", true, { score: n });
    // gte boundary: 5 >= 5 ok; 4.9 not.
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 5 }, [scored(5)])).toEqual({
      satisfied: true,
      reason: "m=5 (need >= 5)",
    });
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 5 }, [scored(4.9)]).satisfied).toBe(false);

    // lte boundary
    expect(evaluateCriteria({ type: "score", evaluator: "m", lte: 10 }, [scored(10)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", lte: 10 }, [scored(10.1)]).satisfied).toBe(false);

    // eq strict
    expect(evaluateCriteria({ type: "score", evaluator: "m", eq: 3 }, [scored(3)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", eq: 3 }, [scored(3.0)]).satisfied).toBe(true);
    expect(evaluateCriteria({ type: "score", evaluator: "m", eq: 3 }, [scored(3.1)]).satisfied).toBe(false);

    // combined checks joined with " and "
    const multi = evaluateCriteria(
      { type: "score", evaluator: "m", gte: 1, lte: 10, eq: 5 },
      [scored(5)],
    );
    expect(multi.satisfied).toBe(true);
    expect(multi.reason).toBe("m=5 (need >= 1 and <= 10 and == 5)");

    // no thresholds → need "any"
    expect(evaluateCriteria({ type: "score", evaluator: "m" }, [scored(1)]).reason).toBe(
      "m=1 (need any)",
    );

    // missing / no score
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 1 }, [])).toEqual({
      satisfied: false,
      reason: "unknown evaluator: m",
    });
    expect(evaluateCriteria({ type: "score", evaluator: "m", gte: 1 }, [er("m", true)])).toEqual({
      satisfied: false,
      reason: "m produced no score",
    });
  });

  it("all / any / not compose reasons exactly", () => {
    const results = [er("a", true), er("b", false)];
    const all = evaluateCriteria(
      {
        type: "all",
        of: [
          { type: "pass", evaluators: ["a"] },
          { type: "pass", evaluators: ["b"] },
        ],
      },
      results,
    );
    expect(all.satisfied).toBe(false);
    expect(all.reason).toBe("failing: b");

    const allOk = evaluateCriteria(
      { type: "all", of: [{ type: "pass", evaluators: ["a"] }] },
      results,
    );
    expect(allOk).toEqual({ satisfied: true, reason: "all sub-criteria satisfied" });

    const any = evaluateCriteria(
      {
        type: "any",
        of: [
          { type: "pass", evaluators: ["b"] },
          { type: "pass", evaluators: ["a"] },
        ],
      },
      results,
    );
    expect(any.satisfied).toBe(true);
    expect(any.reason).toBe("required checks passed: a");

    const none = evaluateCriteria(
      {
        type: "any",
        of: [
          { type: "pass", evaluators: ["b"] },
          { type: "pass", evaluators: ["ghost"] },
        ],
      },
      results,
    );
    expect(none.satisfied).toBe(false);
    expect(none.reason).toBe("none of: failing: b | unknown evaluator(s): ghost");

    const not = evaluateCriteria({ type: "not", of: { type: "all-pass" } }, [er("a", true)]);
    expect(not).toEqual({ satisfied: false, reason: "not(all checks passed)" });
    const notFail = evaluateCriteria({ type: "not", of: { type: "all-pass" } }, [er("a", false)]);
    expect(notFail.satisfied).toBe(true);
    expect(notFail.reason).toBe("not(failing: a)");
  });

  it("describeCriteria renders exact operators and connectors", () => {
    expect(describeCriteria({ type: "all-pass" })).toMatch(/all checks pass/i);
    expect(describeCriteria({ type: "pass", evaluators: ["t1", "t2"] })).toContain("t1");
    expect(describeCriteria({ type: "pass", evaluators: ["t1", "t2"] })).toContain("t2");
    expect(describeCriteria({ type: "score", evaluator: "m", gte: 1, lte: 2, eq: 1.5 })).toContain("m");
    expect(describeCriteria({ type: "score", evaluator: "m", gte: 1 })).toMatch(/>=/);
    expect(describeCriteria({ type: "score", evaluator: "m" })).toMatch(/is produced|score/i);
    expect(
      describeCriteria({
        type: "all",
        of: [{ type: "all-pass" }, { type: "pass", evaluators: ["t"] }],
      }),
    ).toMatch(/AND/);
    expect(
      describeCriteria({
        type: "any",
        of: [{ type: "all-pass" }, { type: "pass", evaluators: ["t"] }],
      }),
    ).toMatch(/OR/);
    expect(describeCriteria({ type: "not", of: { type: "all-pass" } })).toMatch(/NOT/i);
  });
});

// ─── tasks/base.ts ───────────────────────────────────────────────────────────
describe("mut: languageCommands and standardEvaluators", () => {
  it("returns exact commands for every known language key (case-insensitive)", () => {
    expect(languageCommands("typescript")).toEqual({
      test: "npm test",
      check: "npx tsc --noEmit",
    });
    expect(languageCommands("TypeScript")).toEqual({
      test: "npm test",
      check: "npx tsc --noEmit",
    });
    expect(languageCommands("javascript")).toEqual({
      test: "npm test",
      check: "npx eslint .",
    });
    expect(languageCommands("python")).toEqual({ test: "pytest -q", check: "ruff check ." });
    expect(languageCommands("rust")).toEqual({
      test: "cargo test",
      check: "cargo clippy -- -D warnings",
    });
    expect(languageCommands("go")).toEqual({ test: "go test ./...", check: "go vet ./..." });
    expect(languageCommands("java")).toEqual({ test: "mvn -q test" });
    expect(languageCommands("ruby")).toEqual({ test: "bundle exec rspec" });
  });

  it("falls back to the configure-your-test-command stub for unknown/empty language", () => {
    const fb = languageCommands("cobol");
    expect(fb.test).toBe("echo 'configure your test command' && false");
    expect(fb.check).toBeUndefined();
    expect(languageCommands(undefined).test).toBe("echo 'configure your test command' && false");
    expect(languageCommands("").test).toBe("echo 'configure your test command' && false");
  });

  it("standardEvaluators emits tests always and static-check only when check exists", () => {
    const ts = parseSpec({
      name: "t",
      requirements: "x",
      driver: { uses: "mock" },
      stack: { language: "typescript" },
    });
    const tsEvals = standardEvaluators(ts);
    expect(tsEvals).toEqual([
      { uses: "command", as: "tests", options: { command: "npm test" } },
      { uses: "command", as: "static-check", options: { command: "npx tsc --noEmit" } },
    ]);

    const java = parseSpec({
      name: "j",
      requirements: "x",
      driver: { uses: "mock" },
      stack: { language: "java" },
    });
    // java has no check → only tests
    expect(standardEvaluators(java)).toEqual([
      { uses: "command", as: "tests", options: { command: "mvn -q test" } },
    ]);
  });

  it("createTaskType wires type/description/validate and prompt assembly", () => {
    const task = createTaskType({
      type: "function",
      description: "impl a function",
      role: "You write functions.",
      guidance: ["Keep pure.", "Cover edges."],
      recommendedEvaluators: (s) => standardEvaluators(s),
      validate: (s) => (s.name ? [] : ["name required"]),
    });
    expect(task.type).toBe("function");
    expect(task.description).toBe("impl a function");
    expect(task.validate?.({ name: "" } as never)).toEqual(["name required"]);

    const spec = parseSpec({
      name: "isPalindrome",
      description: "palindrome check",
      requirements: "return true for palindromes",
      driver: { uses: "mock" },
      stack: { language: "typescript", framework: "vitest", packageManager: "npm" },
      evaluators: [{ uses: "command", as: "tests", options: { command: "npm test" } }],
    });

    const sys = task.buildSystemPrompt(spec);
    expect(sys.startsWith("You write functions.")).toBe(true);
    expect(sys).toContain("operating inside an automated feedback loop");
    expect(sys).toContain("- Keep pure.");
    expect(sys).toContain("- Cover edges.");
    expect(sys).toContain("Confine all edits to the workspace directory.");

    const init = task.buildInitialPrompt(spec);
    expect(init).toContain("# Task: isPalindrome");
    expect(init).toContain("palindrome check");
    expect(init).toContain("## Requirements");
    expect(init).toContain("return true for palindromes");
    expect(init).toContain("## Stack");
    expect(init).toContain("typescript / vitest / (npm)");
    expect(init).toContain("## Success is measured by");
    expect(init).toContain("- **tests** (command) — runs `npm test`");
    expect(init).toContain("Implement the requirements now.");

    const noDesc = parseSpec({
      name: "x",
      requirements: "do it",
      driver: { uses: "mock" },
    });
    // No description → blank description line filtered out.
    expect(task.buildInitialPrompt(noDesc)).not.toMatch(/\n\n\n/);
    expect(task.buildInitialPrompt(noDesc)).toContain("Unspecified stack.");

    // No evaluators → describeChecks empty message.
    const noEvals = parseSpec({
      name: "x",
      requirements: "do it",
      driver: { uses: "mock" },
      evaluators: [],
    });
    // parseSpec may inject defaults; force empty via createTaskType path with empty list:
    const emptySpec = { ...noEvals, evaluators: [] as typeof noEvals.evaluators };
    expect(task.buildInitialPrompt(emptySpec)).toContain(
      "(no automated checks configured yet — satisfy the requirements directly)",
    );

    // Iteration: default vs custom prompts.iteration.
    const fb = {
      passed: false,
      reason: "failing: tests",
      text: "FEEDBACK_BODY",
      evaluations: [],
    };
    expect(task.buildIterationPrompt(spec, fb)).toContain('Iteration feedback for "isPalindrome":');
    expect(task.buildIterationPrompt(spec, fb)).toContain("FEEDBACK_BODY");
    expect(task.buildIterationPrompt(spec, fb)).toContain(
      "Make the edits needed to satisfy the failing checks while keeping the passing ones green.",
    );

    const custom = parseSpec({
      name: "c",
      requirements: "x",
      driver: { uses: "mock" },
      prompts: { iteration: "CUSTOM_ITER" },
    });
    expect(task.buildIterationPrompt(custom, fb)).toBe("CUSTOM_ITER\n\nFEEDBACK_BODY");
  });

  it("stackLine omits framework/packageManager when absent", () => {
    const task = createTaskType({
      type: "generic",
      description: "g",
      role: "r",
      guidance: [],
      recommendedEvaluators: () => [],
    });
    const langOnly = parseSpec({
      name: "x",
      requirements: "r",
      driver: { uses: "mock" },
      stack: { language: "python" },
    });
    expect(task.buildInitialPrompt(langOnly)).toContain("## Stack\npython\n");
  });

  it("describeChecks omits the runs-command suffix when options.command is not a string", () => {
    const task = createTaskType({
      type: "generic",
      description: "g",
      role: "r",
      guidance: [],
      recommendedEvaluators: () => [],
    });
    const spec = parseSpec({
      name: "x",
      requirements: "r",
      driver: { uses: "mock" },
      evaluators: [{ uses: "experiment", as: "metric", options: { command: 123 } as never }],
    });
    // Force non-string command through the evaluator options for the prompt path.
    const forced = {
      ...spec,
      evaluators: [{ uses: "experiment", as: "metric", options: { metric: "x" } }],
    };
    const init = task.buildInitialPrompt(forced);
    expect(init).toContain("- **metric** (experiment)");
    expect(init).not.toContain("— runs");
  });
});
