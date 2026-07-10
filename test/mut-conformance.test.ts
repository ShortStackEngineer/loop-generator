import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runDriverConformance,
  formatConformanceReport,
  scriptedMockOptionsFor,
  conformanceScenarios,
} from "../src/testing/conformance";
import type { ConformanceCheck, ConformanceScenario } from "../src/testing/conformance";
import type { AgentDriver, AgentInvocation, AgentRunResult } from "../src/drivers/types";

const TARGET_FILE = "OUTPUT.txt";

// Every temp workspace the conformance harness makes for us lands under a
// private tmpRoot; we clean it in afterEach so no dir survives a run.
let tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});
function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mut-conf-root-"));
  tmpRoots.push(root);
  return root;
}

function find(checks: ConformanceCheck[], name: string): ConformanceCheck {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`missing check ${name}`);
  return c;
}

/**
 * A fully-compliant prompt-driven driver: it obeys the prompt, corrects itself
 * when feedback arrives, and throws on an aborted signal. It also records every
 * invocation so tests can pin runId / iteration / prompt / feedback text.
 */
function makeGoodDriver(name = "good"): {
  driver: AgentDriver;
  calls: AgentInvocation[];
} {
  const calls: AgentInvocation[] = [];
  const driver: AgentDriver = {
    name,
    async run(invocation): Promise<AgentRunResult> {
      calls.push(invocation);
      if (invocation.signal?.aborted) throw new Error("aborted");
      const m = invocation.prompt.match(/exactly: (\S+)/);
      if (m) writeFileSync(path.join(invocation.workdir, TARGET_FILE), m[1]!);
      return { ok: true, stopReason: "completed" };
    },
  };
  return { driver, calls };
}

describe("conformance: scenario catalog is pinned", () => {
  it("exposes exactly the four scenarios with exact names, descriptions, and iterative flags", () => {
    expect(conformanceScenarios).toEqual<ConformanceScenario[]>([
      { name: "reports-name", description: "driver exposes a non-empty string name" },
      { name: "creates-file", description: "driver creates a requested file in the workspace" },
      {
        name: "applies-feedback",
        description: "driver changes a file across two iterations using feedback",
        iterative: true,
      },
      { name: "honors-abort", description: "driver rejects or returns ok:false for an aborted signal" },
    ]);
  });
});

describe("conformance: a fully-compliant driver", () => {
  it("passes every scenario with the exact success details and report shape", async () => {
    const { driver } = makeGoodDriver("good");
    const report = await runDriverConformance({
      makeDriver: () => driver,
      tmpRoot: freshRoot(),
    });

    expect(report.driver).toBe("good");
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "reports-name",
      "creates-file",
      "applies-feedback",
      "honors-abort",
    ]);
    expect(report.checks.map((c) => c.passed)).toEqual([true, true, true, true]);

    expect(find(report.checks, "reports-name").detail).toBe('name="good"');
    expect(find(report.checks, "reports-name").warning).toBeUndefined();

    expect(find(report.checks, "creates-file").detail).toBe(
      `created ${TARGET_FILE} with expected contents`,
    );

    expect(find(report.checks, "applies-feedback").detail).toBe(
      "applied feedback and corrected the file across iterations",
    );
    expect(find(report.checks, "applies-feedback").description).toBe(
      "driver changes a file across two iterations using feedback",
    );

    const abort = find(report.checks, "honors-abort");
    expect(abort.passed).toBe(true);
    expect(abort.warning).toBe(false);
    expect(abort.detail).toBe("aborted signal was honored (rejected or ok:false)");
  });

  it("stamps every check with a non-negative, small durationMs (subtraction, not addition)", async () => {
    const { driver } = makeGoodDriver();
    const report = await runDriverConformance({
      makeDriver: () => driver,
      tmpRoot: freshRoot(),
    });
    for (const c of report.checks) {
      expect(typeof c.durationMs).toBe("number");
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
      // Date.now() - start is small; Date.now() + start would be ~1.7e12.
      expect(c.durationMs).toBeLessThan(60_000);
    }
  });
});

describe("conformance: invocation wiring (runId, iteration, prompt, feedback)", () => {
  it("passes runId 'conformance', 0-based iterations, and the exact prompt/feedback text", async () => {
    const seen: AgentInvocation[] = [];
    const driver: AgentDriver = {
      name: "recorder",
      async run(invocation): Promise<AgentRunResult> {
        seen.push(invocation);
        const m = invocation.prompt.match(/exactly: (\S+)/);
        if (m) writeFileSync(path.join(invocation.workdir, TARGET_FILE), m[1]!);
        return { ok: true };
      },
    };

    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["honors-abort"],
      tmpRoot: freshRoot(),
    });
    expect(find(report.checks, "applies-feedback").passed).toBe(true);

    // Every invocation carries the fixed run id.
    for (const inv of seen) expect(inv.runId).toBe("conformance");

    // applies-feedback drives iteration 0 then 1 (the arithmetic 0/1 pinned).
    const feedbackCalls = seen.filter((s) => s.prompt.includes(TARGET_FILE));
    const iterZero = seen.find((s) => s.iteration === 0 && s.prompt.includes("containing exactly: WRONG"));
    const iterOne = seen.find((s) => s.iteration === 1);
    expect(iterZero).toBeDefined();
    expect(iterOne).toBeDefined();

    // Iteration 0 of applies-feedback writes the WRONG sentinel exactly.
    expect(iterZero!.prompt).toBe(`Create a file named ${TARGET_FILE} containing exactly: WRONG`);
    expect(iterZero!.feedback).toBeUndefined();

    // Iteration 1 carries the failing feedback with the exact reason/text.
    expect(iterOne!.feedback).toBeDefined();
    expect(iterOne!.feedback!.passed).toBe(false);
    expect(iterOne!.feedback!.reason).toBe("contents incorrect");
    expect(iterOne!.feedback!.evaluations).toEqual([]);
    const token = iterOne!.prompt.match(/exactly: (\S+)$/)![1]!;
    expect(iterOne!.feedback!.text).toBe(
      `The file ${TARGET_FILE} must contain exactly: ${token}`,
    );
    expect(iterOne!.prompt).toBe(
      `Update ${TARGET_FILE} so its entire contents are exactly: ${token}`,
    );
    expect(feedbackCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses a randomized token that round-trips exactly through the file (Math.random/slice pinned)", async () => {
    const tokens: string[] = [];
    const driver: AgentDriver = {
      name: "token-check",
      async run(invocation): Promise<AgentRunResult> {
        const m = invocation.prompt.match(/exactly: (\S+)/);
        if (m) {
          tokens.push(m[1]!);
          writeFileSync(path.join(invocation.workdir, TARGET_FILE), m[1]!);
        }
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    // creates-file passed only because the file content matched the exact token.
    expect(find(report.checks, "creates-file").passed).toBe(true);
    // Token shape: "loopgen-" + up to 8 base36 chars (slice(2,10)).
    for (const t of tokens) {
      expect(t.startsWith("loopgen-")).toBe(true);
      const suffix = t.slice("loopgen-".length);
      expect(suffix.length).toBeGreaterThanOrEqual(1);
      expect(suffix.length).toBeLessThanOrEqual(8);
      expect(suffix).toMatch(/^[0-9a-z]+$/);
    }
  });
});

describe("conformance: skip handling", () => {
  it("marks a skipped scenario passed+warning with detail 'skipped' and durationMs 0", async () => {
    const { driver } = makeGoodDriver();
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback"],
      tmpRoot: freshRoot(),
    });
    const skipped = find(report.checks, "applies-feedback");
    expect(skipped.passed).toBe(true);
    expect(skipped.warning).toBe(true);
    expect(skipped.detail).toBe("skipped");
    expect(skipped.durationMs).toBe(0);
    expect(skipped.description).toBe("driver changes a file across two iterations using feedback");
    // The overall report still passes because a skip is passed:true.
    expect(report.passed).toBe(true);
  });

  it("an empty skip array runs every scenario (skip array is honored, not ignored)", async () => {
    const { driver } = makeGoodDriver();
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: [],
      tmpRoot: freshRoot(),
    });
    for (const c of report.checks) expect(c.detail).not.toBe("skipped");
  });
});

describe("conformance: reports-name scenario branches", () => {
  it("fails an empty-name driver with the exact failure detail", async () => {
    const driver: AgentDriver = { name: "", async run() { return { ok: true }; } };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const name = find(report.checks, "reports-name");
    expect(name.passed).toBe(false);
    expect(name.detail).toBe("name is empty or non-string");
    expect(report.passed).toBe(false);
  });

  it("passes a named driver with the exact name detail", async () => {
    const driver: AgentDriver = { name: "zephyr", async run() { return { ok: true }; } };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const name = find(report.checks, "reports-name");
    expect(name.passed).toBe(true);
    expect(name.detail).toBe('name="zephyr"');
  });
});

describe("conformance: creates-file scenario branches", () => {
  it("fails with 'ok:false' detail (incl. the error) when the driver returns ok:false", async () => {
    const driver: AgentDriver = {
      name: "returns-false",
      async run() {
        return { ok: false, error: "boom" };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const created = find(report.checks, "creates-file");
    expect(created.passed).toBe(false);
    expect(created.detail).toBe("run returned ok:false (boom)");
  });

  it("uses 'no error' placeholder when ok:false without an error field", async () => {
    const driver: AgentDriver = {
      name: "false-no-error",
      async run() {
        return { ok: false };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const created = find(report.checks, "creates-file");
    expect(created.passed).toBe(false);
    expect(created.detail).toBe("run returned ok:false (no error)");
  });

  it("fails with 'was not created' when ok:true but no file is written", async () => {
    const driver: AgentDriver = { name: "noop", async run() { return { ok: true }; } };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const created = find(report.checks, "creates-file");
    expect(created.passed).toBe(false);
    expect(created.detail).toBe(`${TARGET_FILE} was not created`);
  });

  it("fails with a 'contents mismatch' detail (exact, trimmed) when the wrong bytes are written", async () => {
    const driver: AgentDriver = {
      name: "wrong-bytes",
      async run(invocation) {
        writeFileSync(path.join(invocation.workdir, TARGET_FILE), "  nope  ");
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const created = find(report.checks, "creates-file");
    expect(created.passed).toBe(false);
    // readFileSync(...).trim() — leading/trailing space stripped.
    expect(created.detail).toBe('contents mismatch: got "nope"');
  });

  it("passes and cleans up its workspace when the exact token is written", async () => {
    const { driver } = makeGoodDriver();
    const root = freshRoot();
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: root,
    });
    expect(find(report.checks, "creates-file").passed).toBe(true);
    // The scenario rmSync's its own workspace in the finally block.
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("conformance: applies-feedback scenario branches", () => {
  it("fails with 'iteration 0 ok:false' (incl. error) when the first run reports ok:false", async () => {
    const driver: AgentDriver = {
      name: "first-false",
      async run() {
        return { ok: false, error: "first-fail" };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(false);
    expect(fb.detail).toBe("iteration 0 ok:false (first-fail)");
  });

  it("uses an empty '' error placeholder for iteration 0 ok:false without an error field", async () => {
    const driver: AgentDriver = {
      name: "first-false-no-error",
      async run() {
        return { ok: false };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(false);
    // `first.error ?? ""` — empty string, so a trailing empty parens.
    expect(fb.detail).toBe("iteration 0 ok:false ()");
  });

  it("uses an empty '' error placeholder for iteration 1 ok:false without an error field", async () => {
    const driver: AgentDriver = {
      name: "second-false-no-error",
      async run(invocation) {
        if (invocation.iteration === 0) {
          writeFileSync(path.join(invocation.workdir, TARGET_FILE), "WRONG");
          return { ok: true };
        }
        return { ok: false };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(false);
    expect(fb.detail).toBe("iteration 1 ok:false ()");
  });

  it("fails with 'iteration 1 ok:false' (incl. error) when only the second run reports ok:false", async () => {
    let call = 0;
    const driver: AgentDriver = {
      name: "second-false",
      async run(invocation) {
        call += 1;
        if (invocation.iteration === 0) {
          writeFileSync(path.join(invocation.workdir, TARGET_FILE), "WRONG");
          return { ok: true };
        }
        return { ok: false, error: "second-fail" };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(false);
    expect(fb.detail).toBe("iteration 1 ok:false (second-fail)");
    expect(call).toBe(2);
  });

  it("fails with an exact 'after feedback contents' detail when the driver ignores feedback", async () => {
    // Ignores feedback: always leaves WRONG, so the token never lands.
    const driver: AgentDriver = {
      name: "ignores-feedback",
      async run(invocation) {
        writeFileSync(path.join(invocation.workdir, TARGET_FILE), "WRONG");
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(false);
    // The detail names the actual (WRONG) and the expected token.
    expect(fb.detail).toMatch(
      /^after feedback contents="WRONG", expected "loopgen-[0-9a-z]{1,8}"$/,
    );
  });

  it("passes when the driver corrects the file on the fed-back second iteration", async () => {
    const { driver } = makeGoodDriver();
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const fb = find(report.checks, "applies-feedback");
    expect(fb.passed).toBe(true);
    expect(fb.detail).toBe("applied feedback and corrected the file across iterations");
  });
});

describe("conformance: honors-abort scenario branches", () => {
  it("honored via rejection: passed, warning:false, exact honored detail", async () => {
    const driver: AgentDriver = {
      name: "rejects-abort",
      async run(invocation) {
        if (invocation.signal?.aborted) throw new Error("aborted");
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback"],
      tmpRoot: freshRoot(),
    });
    const abort = find(report.checks, "honors-abort");
    expect(abort.passed).toBe(true);
    expect(abort.warning).toBe(false);
    expect(abort.detail).toBe("aborted signal was honored (rejected or ok:false)");
  });

  it("honored via ok:false: passed, warning:false, exact honored detail", async () => {
    const driver: AgentDriver = {
      name: "abort-ok-false",
      async run(invocation) {
        if (invocation.signal?.aborted) return { ok: false, error: "aborted" };
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback"],
      tmpRoot: freshRoot(),
    });
    const abort = find(report.checks, "honors-abort");
    expect(abort.passed).toBe(true);
    expect(abort.warning).toBe(false);
    expect(abort.detail).toBe("aborted signal was honored (rejected or ok:false)");
  });

  it("ignored abort: still passed but warning:true with the exact 'acceptable but not ideal' detail", async () => {
    const driver: AgentDriver = {
      name: "ignores-abort",
      async run() {
        // Never inspects the signal; returns ok:true regardless.
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback"],
      tmpRoot: freshRoot(),
    });
    const abort = find(report.checks, "honors-abort");
    expect(abort.passed).toBe(true);
    expect(abort.warning).toBe(true);
    expect(abort.detail).toBe(
      "driver ignored an already-aborted signal (acceptable but not ideal)",
    );
    // A pure warning does not fail the whole report.
    expect(report.passed).toBe(true);
  });

  it("the harness passes an actually-aborted signal and the exact abort prompt to the driver", async () => {
    let sawAborted: boolean | undefined;
    let sawPrompt: string | undefined;
    let sawToken: string | undefined;
    const driver: AgentDriver = {
      name: "signal-probe",
      async run(invocation) {
        sawAborted = invocation.signal?.aborted;
        sawPrompt = invocation.prompt;
        sawToken = invocation.prompt.match(/containing (\S+)$/)?.[1];
        return { ok: true };
      },
    };
    await runDriverConformance({
      makeDriver: () => driver,
      skip: ["creates-file", "applies-feedback"],
      tmpRoot: freshRoot(),
    });
    expect(sawAborted).toBe(true);
    // Exact abort prompt template (StringLiteral at the call site).
    expect(sawToken).toBeDefined();
    expect(sawPrompt).toBe(`Create ${TARGET_FILE} containing ${sawToken}`);
  });
});

describe("conformance: a thrown error is caught and classified", () => {
  it("classifies a thrown run as passed:false with the exact 'threw:' detail", async () => {
    const driver: AgentDriver = {
      name: "thrower",
      async run() {
        throw new Error("kaboom");
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      // reports-name doesn't call run(); creates-file will throw.
      skip: ["applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    const created = find(report.checks, "creates-file");
    expect(created.passed).toBe(false);
    expect(created.detail).toBe("threw: kaboom");
    // Description and name are preserved on the caught check.
    expect(created.name).toBe("creates-file");
    expect(created.description).toBe("driver creates a requested file in the workspace");
    // catch-path durationMs is Date.now() - start (small); + start would be ~1.7e12.
    expect(created.durationMs).toBeGreaterThanOrEqual(0);
    expect(created.durationMs).toBeLessThan(60_000);
    expect(report.passed).toBe(false);
  });
});

describe("conformance: overall report.passed reflects every check", () => {
  it("is false when any single scenario fails", async () => {
    // Good at everything except creates-file (never writes).
    const driver: AgentDriver = {
      name: "half-good",
      async run(invocation) {
        if (invocation.signal?.aborted) throw new Error("aborted");
        // Only satisfy applies-feedback, never creates-file's single-shot write.
        if (invocation.feedback) {
          const m = invocation.prompt.match(/exactly: (\S+)/);
          if (m) writeFileSync(path.join(invocation.workdir, TARGET_FILE), m[1]!);
        } else if (invocation.prompt.includes("containing exactly: WRONG")) {
          writeFileSync(path.join(invocation.workdir, TARGET_FILE), "WRONG");
        }
        return { ok: true };
      },
    };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      tmpRoot: freshRoot(),
    });
    expect(find(report.checks, "creates-file").passed).toBe(false);
    expect(find(report.checks, "applies-feedback").passed).toBe(true);
    expect(report.passed).toBe(false);
  });
});

describe("conformance: makeDriver may be async", () => {
  it("awaits a promise-returning makeDriver and reports its name", async () => {
    const { driver } = makeGoodDriver("async-made");
    const report = await runDriverConformance({
      makeDriver: async () => driver,
      skip: ["creates-file", "applies-feedback", "honors-abort"],
      tmpRoot: freshRoot(),
    });
    expect(report.driver).toBe("async-made");
    expect(find(report.checks, "reports-name").passed).toBe(true);
  });
});

describe("scriptedMockOptionsFor", () => {
  const scenario = (name: string): ConformanceScenario =>
    conformanceScenarios.find((s) => s.name === name)!;

  it("maps creates-file to a single write step of the exact token", () => {
    expect(scriptedMockOptionsFor(scenario("creates-file"), "TOK")).toEqual({
      steps: [{ files: { [TARGET_FILE]: "TOK" } }],
    });
  });

  it("maps applies-feedback to a WRONG-then-token two-step script", () => {
    expect(scriptedMockOptionsFor(scenario("applies-feedback"), "TOK")).toEqual({
      steps: [{ files: { [TARGET_FILE]: "WRONG" } }, { files: { [TARGET_FILE]: "TOK" } }],
    });
  });

  it("returns undefined for reports-name and honors-abort (the default branch)", () => {
    expect(scriptedMockOptionsFor(scenario("reports-name"), "TOK")).toBeUndefined();
    expect(scriptedMockOptionsFor(scenario("honors-abort"), "TOK")).toBeUndefined();
  });
});

describe("formatConformanceReport", () => {
  it("renders the exact header and one line per check with the right marks", async () => {
    const { driver } = makeGoodDriver("fmt");
    const report = await runDriverConformance({
      makeDriver: () => driver,
      tmpRoot: freshRoot(),
    });
    const text = formatConformanceReport(report);
    const lines = text.split("\n");

    // Header: PASS since the good driver passes everything.
    expect(lines[0]).toBe("Driver conformance: fmt — PASS");
    // One line per check, each starting with two spaces and a mark.
    expect(lines.length).toBe(1 + report.checks.length);

    for (let i = 0; i < report.checks.length; i++) {
      const c = report.checks[i]!;
      const mark = c.passed ? (c.warning ? "⚠" : "✓") : "✗";
      expect(lines[i + 1]).toBe(`  ${mark} ${c.name} — ${c.detail} (${c.durationMs}ms)`);
    }
    // The good driver honored abort → all ✓, no ⚠ and no ✗.
    expect(text).toContain("✓ reports-name");
    expect(text).not.toContain("✗");
    expect(text).not.toContain("⚠");
  });

  it("uses ✗ and FAIL in the header for a failing report, and ⚠ for warnings", async () => {
    // noop fails creates-file & applies-feedback; ignores abort → warning.
    const driver: AgentDriver = { name: "noop", async run() { return { ok: true }; } };
    const report = await runDriverConformance({
      makeDriver: () => driver,
      tmpRoot: freshRoot(),
    });
    const text = formatConformanceReport(report);
    expect(text.split("\n")[0]).toBe("Driver conformance: noop — FAIL");
    expect(text).toContain("✗ creates-file");
    expect(text).toContain("⚠ honors-abort");
  });
});
