import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, rmSync as rmSyncFs } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoopEngine, mapWithConcurrency } from "../src/core/engine";
import type { EngineRegistries } from "../src/core/engine";
import { createDefaultRegistries } from "../src/registry";
import { parseSpec } from "../src/core/spec";
import { silentLogger } from "../src/core/logger";
import type { Logger, LogLevel } from "../src/core/logger";
import type { AgentDriver } from "../src/drivers/types";
import type { TaskType } from "../src/tasks/types";
import type { Observer, ObserverSession } from "../src/observers/types";

// A logger that records every message (with its scope prefix) into a shared sink.
function recordingLogger(sink: Array<{ level: string; msg: string }>, scope = ""): Logger {
  const p = (m: string) => (scope ? `[${scope}] ${m}` : m);
  const self: Logger = {
    level: "debug" as LogLevel,
    debug: (m: string) => sink.push({ level: "debug", msg: p(m) }),
    info: (m: string) => sink.push({ level: "info", msg: p(m) }),
    warn: (m: string) => sink.push({ level: "warn", msg: p(m) }),
    error: (m: string) => sink.push({ level: "error", msg: p(m) }),
    child: (s: string) => recordingLogger(sink, scope ? `${scope}:${s}` : s),
  };
  return self;
}

function initGitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

const CHECK_42 = { uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` } };

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-muteng-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function engine(regs?: EngineRegistries, log: Logger = silentLogger): LoopEngine {
  return new LoopEngine(regs ?? createDefaultRegistries(), log);
}

// ---------------------------------------------------------------------------
describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order and limit", async () => {
    const order: number[] = [];
    const out = await mapWithConcurrency([10, 5, 1], 3, async (n, i) => {
      await new Promise((r) => setTimeout(r, n));
      order.push(i);
      return n * 2;
    });
    expect(out).toEqual([20, 10, 2]); // order preserved
    expect(order).toEqual([2, 1, 0]); // completion order differs (proves concurrency)
  });

  it("runs sequentially at limit 1 (never two in flight)", async () => {
    let live = 0;
    let maxLive = 0;
    await mapWithConcurrency([1, 1, 1], 1, async () => {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    expect(maxLive).toBe(1);
  });

  it("clamps a limit above item count and returns empty for no items", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([7], 100, async (n) => n + 1)).toEqual([8]);
  });
});

// ---------------------------------------------------------------------------
describe("terminal-path reasons and durations", () => {
  it("success: durationMs is a small non-negative number, reason is the criteria verdict", async () => {
    const spec = parseSpec({
      name: "ok",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 3, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.reason).toBe("all checks passed");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThan(60_000);
    expect(report.iterations[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.iterations[0]!.durationMs).toBeLessThan(60_000);
  });

  it("max-iterations: reason embeds the real feedback reason (not the literal 'criteria')", async () => {
    const spec = parseSpec({
      name: "never",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "nope" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("max-iterations");
    expect(report.reason).toBe("exhausted 2 iteration(s) without satisfying: failing: check");
    expect(report.reason).not.toMatch(/satisfying: criteria$/);
    expect(report.durationMs).toBeLessThan(60_000);
  });

  it("aborted: exact reason and bounded duration", async () => {
    const spec = parseSpec({
      name: "abort",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 2, baseline: false },
    });
    const report = await engine().run(spec, { baseDir: workdir, signal: AbortSignal.abort() });
    expect(report.outcome).toBe("aborted");
    expect(report.reason).toBe("run aborted");
    expect(report.success).toBe(false);
    expect(report.durationMs).toBeLessThan(60_000);
    expect(report.iterations).toHaveLength(0);
  });

  it("baseline-vacuous (strict): exact reason, warns, and bounded duration", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42"); // already green
    const spec = parseSpec({
      name: "vac",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 2, baseline: "strict" },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("baseline-vacuous");
    expect(report.reason).toBe(
      "strict baseline: success criteria already pass BEFORE any agent work — your checks likely do not verify the new requirement",
    );
    expect(report.warnings.join("\n")).toMatch(/already pass BEFORE any agent work/);
    expect(report.durationMs).toBeLessThan(60_000);
    expect(report.iterations).toHaveLength(0);
  });

  it("non-strict baseline that passes only warns, then still runs the loop", async () => {
    writeFileSync(path.join(workdir, "answer.txt"), "42");
    const spec = parseSpec({
      name: "vac-warn",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: true },
    });
    const report = await engine().run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.baseline?.satisfied).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/already pass BEFORE any agent work/);
    expect(report.iterations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("budget ceiling boundaries and exact messages", () => {
  const priceyDriver = (usage: Record<string, number>): AgentDriver => ({
    name: "pricey",
    async run(inv) {
      writeFileSync(path.join(inv.workdir, "answer.txt"), "nope"); // never converges
      return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"], usage };
    },
  });

  function run(limits: Record<string, unknown>, usage: Record<string, number>) {
    const regs = createDefaultRegistries();
    regs.drivers.override(priceyDriver(usage));
    const spec = parseSpec({
      name: "b",
      requirements: "x",
      driver: { uses: "pricey" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 10, baseline: false, ...limits },
    });
    return new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
  }

  it("cost uses strict > (equal cumulative cost does not trip)", async () => {
    // per-iter 0.5, cap 1.0: iter0=0.5, iter1=1.0 (==cap, keep going), iter2=1.5 (>cap, stop).
    const report = await run({ maxCostUsd: 1.0 }, { costUsd: 0.5 });
    expect(report.outcome).toBe("budget-exceeded");
    expect(report.iterations).toHaveLength(3);
    expect(report.reason).toBe(
      "cost budget exceeded: $1.5000 spent > $1.0000 limit (limits.maxCostUsd)",
    );
    expect(report.durationMs).toBeLessThan(60_000);
  });

  it("tokens use strict > and count input+output combined with an exact message", async () => {
    // per-iter 600 tokens (400+200), cap 1000: iter0=600, iter1=1200 (>cap, stop).
    const report = await run({ maxTokens: 1000 }, { inputTokens: 400, outputTokens: 200 });
    expect(report.outcome).toBe("budget-exceeded");
    expect(report.iterations).toHaveLength(2);
    expect(report.reason).toBe(
      "token budget exceeded: 1200 tokens used (input + output) > 1000 limit (limits.maxTokens)",
    );
  });

  it("token boundary: equal cumulative tokens do not trip", async () => {
    // per-iter 500, cap 1000: iter0=500, iter1=1000 (==cap keep), iter2=1500 (>cap stop).
    const report = await run({ maxTokens: 1000 }, { inputTokens: 300, outputTokens: 200 });
    expect(report.outcome).toBe("budget-exceeded");
    expect(report.iterations).toHaveLength(3);
  });

  it("generous cost budget never fires (ends max-iterations, not budget-exceeded)", async () => {
    const report = await run({ maxCostUsd: 1000, maxIterations: 2 }, { costUsd: 0.1 });
    expect(report.outcome).toBe("max-iterations");
  });

  it("generous token budget never fires", async () => {
    const report = await run({ maxTokens: 1_000_000, maxIterations: 2 }, { inputTokens: 10, outputTokens: 5 });
    expect(report.outcome).toBe("max-iterations");
  });
});

// ---------------------------------------------------------------------------
describe("driver-error firstLine logging", () => {
  function runWithDriver(driver: AgentDriver) {
    const regs = createDefaultRegistries();
    regs.drivers.override(driver);
    const sink: Array<{ level: string; msg: string }> = [];
    const spec = parseSpec({
      name: "err",
      requirements: "x",
      driver: { uses: driver.name },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false },
    });
    return new LoopEngine(regs, silentLogger)
      .run(spec, { baseDir: workdir, log: recordingLogger(sink) })
      .then((report) => ({ report, sink }));
  }

  it("logs only the first non-empty line of a multi-line driver error", async () => {
    const { sink } = await runWithDriver({
      name: "d-multi",
      async run() {
        return { ok: false, stopReason: "error", error: "first bad line\nsecond line\nthird" };
      },
    });
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg);
    expect(warns.some((m) => m.includes("driver error: first bad line"))).toBe(true);
    expect(warns.some((m) => m.includes("second line"))).toBe(false);
  });

  it("falls back to '(no detail)' when the error is undefined", async () => {
    const { sink } = await runWithDriver({
      name: "d-none",
      async run() {
        return { ok: false, stopReason: "error" };
      },
    });
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg);
    expect(warns.some((m) => m.includes("driver error: (no detail)"))).toBe(true);
  });

  it("skips leading blank/whitespace lines to the first meaningful one", async () => {
    const { sink } = await runWithDriver({
      name: "d-blank",
      async run() {
        return { ok: false, stopReason: "error", error: "\n\n   real detail   \nmore" };
      },
    });
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg);
    expect(warns.some((m) => m.includes("driver error: real detail"))).toBe(true);
  });

  it("warns specifically about a max_turns stop (incomplete)", async () => {
    const { sink } = await runWithDriver({
      name: "d-maxturns",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "nope");
        return { ok: true, stopReason: "max_turns", changedFiles: ["answer.txt"] };
      },
    });
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg);
    expect(warns.some((m) => m.includes("max turns reached (incomplete)"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("iterationSignal composition (observed via inv.signal)", () => {
  function recordSignal() {
    const captured: Array<AbortSignal | undefined> = [];
    const driver: AgentDriver = {
      name: "sigrec",
      async run(inv) {
        captured.push(inv.signal);
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(driver);
    return { captured, regs };
  }

  function spec(limits: Record<string, unknown>) {
    return parseSpec({
      name: "sig",
      requirements: "x",
      driver: { uses: "sigrec" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false, ...limits },
    });
  }

  it("no external signal and no timeout → driver signal is undefined", async () => {
    const { captured, regs } = recordSignal();
    await new LoopEngine(regs, silentLogger).run(spec({}), { baseDir: workdir });
    expect(captured[0]).toBeUndefined();
  });

  it("a per-iteration timeout alone yields a defined (non-aborted) signal", async () => {
    const { captured, regs } = recordSignal();
    await new LoopEngine(regs, silentLogger).run(spec({ iterationTimeoutMs: 5000 }), { baseDir: workdir });
    expect(captured[0]).toBeInstanceOf(AbortSignal);
    expect(captured[0]!.aborted).toBe(false);
  });

  it("an external signal alone is passed through by identity (length-1 fast path)", async () => {
    const { captured, regs } = recordSignal();
    const ctrl = new AbortController();
    await new LoopEngine(regs, silentLogger).run(spec({}), { baseDir: workdir, signal: ctrl.signal });
    expect(captured[0]).toBe(ctrl.signal);
  });

  it("external + timeout are combined into a NEW signal (not the external one)", async () => {
    const { captured, regs } = recordSignal();
    const ctrl = new AbortController();
    await new LoopEngine(regs, silentLogger).run(spec({ iterationTimeoutMs: 5000 }), {
      baseDir: workdir,
      signal: ctrl.signal,
    });
    expect(captured[0]).toBeInstanceOf(AbortSignal);
    expect(captured[0]).not.toBe(ctrl.signal);
    expect(captured[0]!.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("plug-in resolution failures", () => {
  it("throws (and reports) when a spec declares an observer but no observer registry exists", async () => {
    const base = createDefaultRegistries();
    const regs: EngineRegistries = {
      drivers: base.drivers,
      evaluators: base.evaluators,
      tasks: base.tasks,
      // no observers registry
    };
    const spec = parseSpec({
      name: "no-obs-reg",
      requirements: "x",
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      observability: { observers: [{ uses: "jsonl" }] },
      limits: { maxIterations: 1, baseline: false },
    });
    const report = await engine(regs).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("error");
    expect(report.reason).toBe('No observer registry is configured, but the spec declares observer "jsonl".');
    expect(report.error).toBe(report.reason);
  });

  it("preflight failure: outcome preflight-failed with a bulleted error list", async () => {
    const driver: AgentDriver = {
      name: "pf-fail",
      async preflight() {
        return { ok: false, errors: ["boom preflight"] };
      },
      async run() {
        return { ok: true, stopReason: "completed" };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(driver);
    const spec = parseSpec({
      name: "pf",
      requirements: "x",
      driver: { uses: "pf-fail" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("preflight-failed");
    expect(report.reason).toContain("preflight failed:");
    expect(report.reason).toContain("  • boom preflight");
    expect(report.preflight?.ok).toBe(false);
    expect(report.durationMs).toBeLessThan(60_000);
  });

  it("task validation failure short-circuits with the joined errors", async () => {
    const vtask: TaskType = {
      type: "vtask",
      recommendedEvaluators: () => [],
      buildSystemPrompt: () => "sys",
      buildInitialPrompt: () => "init",
      buildIterationPrompt: () => "iter",
      validate: () => ["bad one", "bad two"],
    };
    const regs = createDefaultRegistries();
    regs.tasks.register(vtask);
    const spec = parseSpec({
      name: "vt",
      requirements: "x",
      task: { type: "vtask" },
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("error");
    expect(report.reason).toBe("task validation failed: bad one; bad two");
    expect(report.error).toBe("bad one; bad two");
    expect(report.durationMs).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
describe("workspace snapshot='git' on a non-git dir warns and falls back", () => {
  it("emits the git-snapshot fallback warning and still detects content changes", async () => {
    const sink: Array<{ level: string; msg: string }> = [];
    const spec = parseSpec({
      name: "gitwarn",
      requirements: "x",
      workspace: { dir: ".", snapshot: "git", ignore: [] },
      driver: { uses: "mock", options: { steps: [{ files: { "answer.txt": "42" } }] } },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false },
    });
    // A lint preflight rule blocks git-snapshot on a non-git dir; skip preflight
    // to reach the in-run fallback warning this test targets.
    const report = await engine(undefined, recordingLogger(sink)).run(spec, {
      baseDir: workdir,
      skipPreflight: true,
    });
    expect(report.outcome).toBe("success");
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg).join("\n");
    expect(warns).toMatch(/workspace\.snapshot is "git" but .* is not a git repo/);
    expect(warns).toMatch(/using content-hash change detection/);
  });
});

// ---------------------------------------------------------------------------
describe("observer session isolation", () => {
  it("a throwing begin() is logged and dropped; throwing hooks never break the run", async () => {
    const calls: string[] = [];
    const throwingBegin: Observer = {
      name: "obs-throw-begin",
      begin() {
        throw new Error("begin exploded");
      },
    };
    const throwingHooks: Observer = {
      name: "obs-throw-hooks",
      begin(): ObserverSession {
        return {
          onIteration() {
            calls.push("iter");
            throw new Error("iter boom");
          },
          onAgentEvent() {
            calls.push("event");
            throw new Error("event boom");
          },
          onRunEnd() {
            calls.push("end");
            throw new Error("end boom");
          },
        };
      },
    };
    const emitter: AgentDriver = {
      name: "emitter2",
      async run(inv) {
        inv.emit?.({ kind: "model-message", text: "hi" });
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(emitter);
    regs.observers!.register(throwingBegin);
    regs.observers!.register(throwingHooks);
    const sink: Array<{ level: string; msg: string }> = [];
    const spec = parseSpec({
      name: "obs",
      requirements: "x",
      driver: { uses: "emitter2" },
      evaluators: [CHECK_42],
      observability: { observers: [{ uses: "obs-throw-begin" }, { uses: "obs-throw-hooks" }] },
      limits: { maxIterations: 1, baseline: false },
    });
    const report = await new LoopEngine(regs, recordingLogger(sink)).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success"); // isolation holds
    expect(calls).toContain("event");
    expect(calls).toContain("iter");
    expect(calls).toContain("end");
    const warns = sink.filter((e) => e.level === "warn").map((e) => e.msg).join("\n");
    expect(warns).toMatch(/observer "obs-throw-begin" failed to start: begin exploded/);
  });
});

// ---------------------------------------------------------------------------
describe("content-hash cap: driver-reported files are trusted only when the walk hit the cap", () => {
  it("treats driver-reported changes as authoritative (unverified) once the cap is reached", async () => {
    // Fill the workspace past CONTENT_SNAPSHOT_FILE_CAP so the content walk caps out.
    const many = path.join(workdir, "many");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 5001; i++) writeFileSync(path.join(many, `f${i}.txt`), String(i));
    writeFileSync(path.join(workdir, "answer.txt"), "42"); // check already green

    const liar: AgentDriver = {
      name: "claimer",
      async run() {
        // Touches nothing, but claims an edit.
        return { ok: true, stopReason: "completed", changedFiles: ["ghost.ts"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(liar);
    const spec = parseSpec({
      name: "cap",
      requirements: "x",
      driver: { uses: "claimer" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.iterations[0]!.changed).toBe(true);
    expect(report.iterations[0]!.changedFiles).toEqual(["ghost.ts"]);
    expect(report.iterations[0]!.diffStat).toBe("1 file(s) driver-reported (content-hash walk hit cap)");
    expect(report.warnings.join("\n")).toMatch(
      /content-hash walk hit the file cap; treating driver-reported changedFiles as the change list \(unverified\)/,
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe("spec/evaluator tamper exact reasons", () => {
  it("spec-tampered: exact reason when the agent edits the watched spec file", async () => {
    const specFile = path.join(workdir, "my.loop.yaml");
    writeFileSync(specFile, "original: true\n");
    const editor: AgentDriver = {
      name: "spec-editor",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42"); // pass the check
        writeFileSync(specFile, "tampered: yes\n"); // ...but edit the spec
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(editor);
    const spec = parseSpec({
      name: "spec-tamper",
      requirements: "x",
      driver: { uses: "spec-editor" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 1, baseline: false, specGuard: "error" },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir, specFile });
    expect(report.outcome).toBe("spec-tampered");
    expect(report.success).toBe(false);
    expect(report.reason).toBe(
      "the agent modified the loop spec file during the run (specGuard: error) — success criteria may have been altered",
    );
  });

  it("evaluator-tampered: exact reason listing the guarded file the agent deleted", async () => {
    writeFileSync(path.join(workdir, "watched.txt"), "keep me");
    const deleter: AgentDriver = {
      name: "guard-deleter",
      async run(inv) {
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
        rmSyncFs(path.join(inv.workdir, "watched.txt"));
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(deleter);
    const spec = parseSpec({
      name: "eval-tamper",
      requirements: "x",
      driver: { uses: "guard-deleter" },
      evaluators: [{ uses: "command", as: "check", options: { command: `test "$(cat answer.txt)" = "42"` }, guard: ["watched.txt"] }],
      limits: { maxIterations: 1, baseline: false, evaluatorGuard: "error" },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("evaluator-tampered");
    expect(report.success).toBe(false);
    expect(report.reason).toBe(
      "the agent modified evaluator file(s) during the run (evaluatorGuard: error): watched.txt — success checks may have been altered",
    );
  });
});

// ---------------------------------------------------------------------------
describe("overall change summary (git) uses baseline→final tree diff", () => {
  it("reports the union of changed files across the whole run with a --stat", async () => {
    initGitRepo(workdir);
    const twoFile: AgentDriver = {
      name: "two-file",
      async run(inv) {
        if (inv.iteration === 0) {
          writeFileSync(path.join(inv.workdir, "a.txt"), "one");
          return { ok: true, stopReason: "completed", changedFiles: ["a.txt"] };
        }
        writeFileSync(path.join(inv.workdir, "answer.txt"), "42");
        return { ok: true, stopReason: "completed", changedFiles: ["answer.txt"] };
      },
    };
    const regs = createDefaultRegistries();
    regs.drivers.override(twoFile);
    const spec = parseSpec({
      name: "overall",
      requirements: "x",
      driver: { uses: "two-file" },
      evaluators: [CHECK_42],
      limits: { maxIterations: 3, baseline: false },
    });
    const report = await new LoopEngine(regs, silentLogger).run(spec, { baseDir: workdir });
    expect(report.outcome).toBe("success");
    expect(report.changedFiles!.sort()).toEqual(["a.txt", "answer.txt"]);
    expect(report.diffStat).toContain("a.txt");
    expect(report.diffStat).toContain("answer.txt");
  });
});
