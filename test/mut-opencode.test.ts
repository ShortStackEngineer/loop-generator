import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  opencodeDriver,
  parseJsonl,
  finalAssistantText,
  extractSessionId,
  extractUsage,
  extractError,
  formatErrorEvent,
  cleanSummary,
  lastMeaningfulLine,
  OPENCODE_OPTION_KEYS,
  type OpencodeError,
} from "../src/drivers/opencode";
import { silentLogger } from "../src/core/logger";
import type { AgentEvent, AgentInvocation } from "../src/drivers/types";

// ─────────────────────────────────────────────────────────────────────────────
// A richer fake `opencode` CLI than the one in opencode-driver.test.ts. It can:
//   • capture argv (FAKE_OPENCODE_ARGV_OUT)
//   • respond to --version (preflight probe)
//   • emit an arbitrary JSONL fixture verbatim (FAKE_OPENCODE_STDOUT) so tests
//     drive run() through exact usage/session/error/summary shapes
//   • write arbitrary stderr (FAKE_OPENCODE_STDERR)
//   • exit with an arbitrary code (FAKE_OPENCODE_EXIT)
//   • fall back to the "completed" behavior (parse the message, write a file)
// `.cjs` so it runs as CommonJS regardless of the repo's "type":"module".
// ─────────────────────────────────────────────────────────────────────────────
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("opencode 1.0.0-fake"); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
if (process.env.FAKE_OPENCODE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_OPENCODE_ARGV_OUT, JSON.stringify(args));

// A "hang" mode: sleep long enough that a mid-run AbortSignal SIGKILLs us.
if (process.env.FAKE_OPENCODE_HANG) { setTimeout(() => process.exit(0), 5000); return; }

const stdoutFixture = process.env.FAKE_OPENCODE_STDOUT;
if (stdoutFixture !== undefined) {
  if (stdoutFixture) process.stdout.write(stdoutFixture);
  if (process.env.FAKE_OPENCODE_STDERR) process.stderr.write(process.env.FAKE_OPENCODE_STDERR);
  const code = process.env.FAKE_OPENCODE_EXIT;
  process.exit(code !== undefined ? Number(code) : 0);
}

// Default "completed" behavior: parse the run message, write a target file.
const runIdx = args.indexOf("run");
const message = runIdx >= 0 ? args[runIdx + 1] : "";
const dIdx = args.indexOf("--dir");
const cwd = dIdx >= 0 ? args[dIdx + 1] : process.cwd();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SES = "ses_fake1234567890";
let file = "OUTPUT.txt";
const named = message.match(/file named (\S+)/) || message.match(/Update (\S+)/);
if (named) file = named[1];
const content = message.match(/exactly:\s*(\S+)/) || message.match(/containing\s+(\S+)/);
if (content) fs.writeFileSync(path.resolve(cwd, file), content[1]);
emit({ type: "step_start", sessionID: SES, part: { id: "prt_s", type: "step-start", snapshot: "abc123" } });
emit({ type: "text", sessionID: SES, part: { id: "prt_1", type: "text", text: "Done." } });
emit({ type: "step_finish", sessionID: SES, part: { type: "step-finish", reason: "stop", cost: 0.001, tokens: { input: 671, output: 8, reasoning: 0, cache: { read: 0 } } } });
process.exit(0);
`;

let binDir: string;
let binPath: string;
let prevBin: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-mutopencodebin-"));
  binPath = path.join(binDir, "opencode-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  prevBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = binPath;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = prevBin;
  rmSync(binDir, { recursive: true, force: true });
});

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-mutopencode-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function invocation(over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    runId: "r",
    iteration: 0,
    workdir,
    prompt: "Create a file named OUTPUT.txt whose entire contents are exactly: hello123",
    options: {},
    log: silentLogger,
    ...over,
  };
}

/** Run the driver with a verbatim stdout fixture + optional stderr/exit. */
async function runWithStdout(
  stdout: string,
  over: {
    stderr?: string;
    exit?: number;
    options?: Record<string, unknown>;
    invocation?: Partial<AgentInvocation>;
    emit?: (e: AgentEvent) => void;
  } = {},
) {
  const env: Record<string, string> = { FAKE_OPENCODE_STDOUT: stdout };
  if (over.stderr !== undefined) env.FAKE_OPENCODE_STDERR = over.stderr;
  if (over.exit !== undefined) env.FAKE_OPENCODE_EXIT = String(over.exit);
  return opencodeDriver.run(
    invocation({
      options: { ...over.options, env },
      ...(over.emit ? { emit: over.emit } : {}),
      ...over.invocation,
    }),
  );
}

// A canonical two-step opencode JSONL stream used by several run() tests.
const CANON = [
  JSON.stringify({ type: "step_start", sessionID: "ses_A", part: { id: "prt_s", type: "step-start" } }),
  JSON.stringify({ type: "text", sessionID: "ses_A", part: { id: "prt_1", type: "text", text: "First." } }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_A",
    part: { type: "step-finish", reason: "tool-calls", cost: 0.002, tokens: { input: 200, output: 20 } },
  }),
  JSON.stringify({ type: "text", sessionID: "ses_B", part: { id: "prt_2", type: "text", text: "Second." } }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_B",
    part: { type: "step-finish", reason: "stop", cost: 0.003, tokens: { input: 100, output: 5 } },
  }),
  "",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Driver identity + exported constant
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode driver identity", () => {
  it("has the exact driver name", () => {
    expect(opencodeDriver.name).toBe("opencode");
  });

  it("has the exact driver description", () => {
    expect(opencodeDriver.description).toBe("Invoke OpenCode in headless mode (opencode run --format json).");
  });

  it("exports the exact set of known option keys", () => {
    expect(OPENCODE_OPTION_KEYS).toEqual([
      "model",
      "agent",
      "variant",
      "dangerouslySkipPermissions",
      "pure",
      "resume",
      "env",
      "extraArgs",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preflight (kills L91 name, warning branches, probe branch, modelNote ternary)
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode preflight", () => {
  it("succeeds with model note and binary note, no warnings, when clean", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: { model: "lmstudio/qwen" } });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: lmstudio/qwen");
    expect(pf.notes?.some((n) => n.startsWith("binary: "))).toBe(true);
    expect(pf.warnings ?? []).toEqual([]);
  });

  it("uses the CLI-default model note when no model is configured", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: (CLI default)");
    expect(pf.notes).not.toContain("model: undefined");
  });

  it("warns exactly once for an unknown option key", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: { bogusKey: 1 } });
    expect(pf.ok).toBe(true);
    const joined = (pf.warnings ?? []).join(" ");
    expect(joined).toContain("bogusKey");
    expect(joined).toContain("does not recognize");
  });

  it("warns when dangerouslySkipPermissions is disabled (and not otherwise)", async () => {
    const off = await opencodeDriver.preflight!({ workdir, options: { dangerouslySkipPermissions: false } });
    expect((off.warnings ?? []).join(" ")).toContain("dangerouslySkipPermissions is false");

    const on = await opencodeDriver.preflight!({ workdir, options: { dangerouslySkipPermissions: true } });
    expect((on.warnings ?? []).join(" ")).not.toContain("dangerouslySkipPermissions is false");
  });

  it("fails with an actionable message on invalid options", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: { model: 123 } });
    expect(pf.ok).toBe(false);
    expect((pf.errors ?? []).join(" ")).toContain("opencode options:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run(): argv construction — every flag + the not-configured omissions
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode run() argv", () => {
  async function captureArgv(options: Record<string, unknown>, inv: Partial<AgentInvocation> = {}): Promise<string[]> {
    const argvOut = path.join(workdir, "argv.json");
    await opencodeDriver.run(
      invocation({
        options: { ...options, env: { FAKE_OPENCODE_ARGV_OUT: argvOut } },
        ...inv,
      }),
    );
    return JSON.parse(readFileSync(argvOut, "utf8"));
  }

  it("emits the fixed positional args in exact order", async () => {
    const argv = await captureArgv({}, { prompt: "do the thing", systemPrompt: undefined });
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("do the thing");
    expect(argv[2]).toBe("--dir");
    expect(argv[3]).toBe(workdir);
    expect(argv[4]).toBe("--format");
    expect(argv[5]).toBe("json");
    expect(argv[6]).toBe("--log-level");
    expect(argv[7]).toBe("ERROR");
  });

  it("folds the systemPrompt in front of the prompt as the positional message", async () => {
    const argv = await captureArgv({}, { prompt: "concrete ask", systemPrompt: "SYS" });
    expect(argv[1]).toBe("SYS\n\nconcrete ask");
  });

  it("includes every optional flag when configured", async () => {
    const argv = await captureArgv(
      {
        model: "lmstudio/qwen/qwen3-coder-next",
        agent: "build",
        variant: "high",
        pure: true,
        resume: true,
        extraArgs: ["--flag-x", "val"],
      },
      { resumeSessionId: "prev-sess" },
    );
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--pure");
    // -m directly precedes the model value.
    expect(argv[argv.indexOf("-m") + 1]).toBe("lmstudio/qwen/qwen3-coder-next");
    expect(argv[argv.indexOf("--agent") + 1]).toBe("build");
    expect(argv[argv.indexOf("--variant") + 1]).toBe("high");
    expect(argv[argv.indexOf("--session") + 1]).toBe("prev-sess");
    expect(argv).toContain("--flag-x");
    expect(argv).toContain("val");
  });

  it("omits every optional flag when not configured", async () => {
    const argv = await captureArgv({ dangerouslySkipPermissions: false });
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--pure");
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--agent");
    expect(argv).not.toContain("--variant");
    expect(argv).not.toContain("--session");
  });

  it("adds --session only when BOTH resume is on AND a session id is present", async () => {
    // resume on, but no resumeSessionId → no --session.
    const noId = await captureArgv({ resume: true });
    expect(noId).not.toContain("--session");
    // resumeSessionId present, but resume off → no --session.
    const noResume = await captureArgv({ resume: false }, { resumeSessionId: "sess-1" });
    expect(noResume).not.toContain("--session");
    // both → --session.
    const both = await captureArgv({ resume: true }, { resumeSessionId: "sess-1" });
    expect(both[both.indexOf("--session") + 1]).toBe("sess-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run(): result mapping via exact JSONL fixtures
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode run() result mapping", () => {
  it("maps a completed run: summary, usage, session from a fixture", async () => {
    const r = await runWithStdout(CANON);
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    // The driver runs finalAssistantText through cleanSummary, which collapses
    // the joining newline to a space.
    expect(r.summary).toBe("First. Second.");
    expect(r.sessionId).toBe("ses_B");
    expect(r.usage).toEqual({ inputTokens: 300, outputTokens: 25, costUsd: 0.005, turns: 2 });
    expect(r.error).toBeUndefined();
  });

  it("emits turn-end + usage events per step_finish and nothing for text-only", async () => {
    const events: AgentEvent[] = [];
    await runWithStdout(CANON, { emit: (e) => events.push(e) });
    expect(events).toContainEqual({ kind: "turn-end", turn: 1 });
    expect(events).toContainEqual({ kind: "turn-end", turn: 2 });
    expect(events).toContainEqual({ kind: "usage", usage: { inputTokens: 200, outputTokens: 20 } });
    expect(events).toContainEqual({ kind: "usage", usage: { inputTokens: 100, outputTokens: 5 } });
    // Exactly two turn-end events (one per step_finish), no third.
    expect(events.filter((e) => e.kind === "turn-end")).toHaveLength(2);
  });

  it("emits a turn-end but no usage event for a step_finish that carries no tokens", async () => {
    const stream = [
      JSON.stringify({ type: "step_finish", sessionID: "s", part: { type: "step-finish", reason: "stop" } }),
      "",
    ].join("\n");
    const events: AgentEvent[] = [];
    await runWithStdout(stream, { emit: (e) => events.push(e) });
    expect(events).toContainEqual({ kind: "turn-end", turn: 1 });
    expect(events.some((e) => e.kind === "usage")).toBe(false);
  });

  it("emits usage with only the token field present in a step_finish", async () => {
    const stream = [
      JSON.stringify({ type: "step_finish", sessionID: "s", part: { type: "step-finish", tokens: { input: 42 } } }),
      "",
    ].join("\n");
    const events: AgentEvent[] = [];
    await runWithStdout(stream, { emit: (e) => events.push(e) });
    expect(events).toContainEqual({ kind: "usage", usage: { inputTokens: 42 } });
  });

  it("handles a top-level step_finish event with no part (no tokens crash)", async () => {
    const stream = [JSON.stringify({ type: "step_finish", sessionID: "s" }), ""].join("\n");
    const events: AgentEvent[] = [];
    const r = await runWithStdout(stream, { emit: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    expect(events).toContainEqual({ kind: "turn-end", turn: 1 });
    expect(events.some((e) => e.kind === "usage")).toBe(false);
  });

  it("uses the exact no-parseable-summary fallback when stdout has no text parts", async () => {
    const r = await runWithStdout("not json at all\nmore prose\n");
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("(opencode produced no parseable final summary; see report raw)");
  });

  it("records the raw object count and exit code on a clean run", async () => {
    const r = await runWithStdout(CANON);
    const raw = r.raw as { objects: number; exitCode: number | null };
    expect(raw.objects).toBe(5);
    expect(raw.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run(): failure classification (isFatal branches + error message precedence)
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode run() failures", () => {
  it("treats an error event as fatal even on a zero exit code", async () => {
    const stream = [
      JSON.stringify({
        type: "error",
        sessionID: "ses_E",
        error: { name: "APIError", data: { message: "Invalid model identifier." } },
      }),
      "",
    ].join("\n");
    const r = await runWithStdout(stream, { exit: 0 });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toBe("APIError: Invalid model identifier.");
    expect(r.sessionId).toBe("ses_E");
  });

  it("treats a non-zero exit with no error event as fatal, surfacing the real stderr line", async () => {
    const stderr = ["2026-01-01T00:00:00.000Z ERROR stacktrace noise", "fatal: provider exploded"].join("\n");
    const r = await runWithStdout("", { stderr, exit: 2 });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toBe("fatal: provider exploded");
    expect(r.error).not.toContain("stacktrace noise");
  });

  it("treats a zero exit with no error event as NOT fatal", async () => {
    const r = await runWithStdout(CANON, { exit: 0 });
    expect(r.ok).toBe(true);
  });

  it("falls back to the final text (cleaned) when there is no error event and no meaningful stderr", async () => {
    const stream = [
      JSON.stringify({ type: "text", sessionID: "s", part: { id: "p", type: "text", text: "the   only   clue" } }),
      "",
    ].join("\n");
    // Non-zero exit, only-timestamped stderr → both formatErrorEvent and
    // lastMeaningfulLine yield nothing, so cleanSummary(finalText) wins.
    const r = await runWithStdout(stream, { stderr: "2026-01-01T00:00:00.000Z ERROR only noise\n", exit: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("the only clue");
  });

  it("uses the generic exit-code message when there is no error event, stderr, or final text", async () => {
    const r = await runWithStdout("", { exit: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("opencode CLI failed (exit 7)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run(): abort handling
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode run() abort", () => {
  it("returns aborted immediately for an already-aborted signal (before spawn)", async () => {
    const r = await opencodeDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
    expect(r.error).toBe("aborted");
    // No spawn happened, so no summary/usage.
    expect(r.summary).toBeUndefined();
    expect(r.usage).toBeUndefined();
  });

  it("returns aborted when the signal fires mid-run (child SIGKILLed)", async () => {
    const controller = new AbortController();
    const p = opencodeDriver.run(
      invocation({ options: { env: { FAKE_OPENCODE_HANG: "1" } }, signal: controller.signal }),
    );
    // Abort after the child has spawned so spawnCollect marks it killed.
    setTimeout(() => controller.abort(), 150);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
    expect(r.error).toBe("aborted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run(): spawn error (binary cannot be executed)
// ─────────────────────────────────────────────────────────────────────────────
describe("opencode run() spawn error", () => {
  it("surfaces a spawn error as a stopReason:error result", async () => {
    const prev = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = path.join(binDir, "does-not-exist-xyz");
    try {
      const r = await opencodeDriver.run(invocation({ options: {} }));
      expect(r.ok).toBe(false);
      expect(r.stopReason).toBe("error");
      expect(typeof r.error).toBe("string");
      expect(r.error).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finalAssistantText — text detection (both event shapes) + dedupe + trimming
// ─────────────────────────────────────────────────────────────────────────────
describe("finalAssistantText", () => {
  it("keeps the latest snapshot per part id, joining distinct parts in first-seen order", () => {
    const objs = parseJsonl(
      [
        '{"type":"text","part":{"id":"p1","type":"text","text":"Hel"}}',
        '{"type":"text","part":{"id":"p1","type":"text","text":"Hello"}}',
        '{"type":"text","part":{"id":"p2","type":"text","text":"world"}}',
      ].join("\n"),
    );
    expect(finalAssistantText(objs)).toBe("Hello\nworld");
  });

  it("recognizes a top-level type:text event", () => {
    expect(finalAssistantText([{ type: "text", part: { text: "top-level" } }])).toBe("top-level");
  });

  it("skips a text event whose text is empty (does not treat it as content)", () => {
    const objs: Array<Record<string, unknown>> = [
      { type: "text", part: { id: "p1", type: "text", text: "" } },
      { type: "text", part: { id: "p2", type: "text", text: "kept" } },
    ];
    expect(finalAssistantText(objs)).toBe("kept");
  });

  it("does not throw on a top-level text event that carries no part object", () => {
    // isTextEvent is true from the top-level type, but there is no `part` — the
    // driver must read `part?.text` defensively and simply skip it.
    expect(finalAssistantText([{ type: "text" }])).toBeUndefined();
  });

  it("recognizes a part.type text event even when the top-level type differs", () => {
    expect(finalAssistantText([{ type: "message", part: { type: "text", text: "nested" } }])).toBe("nested");
  });

  it("ignores non-text events entirely", () => {
    expect(finalAssistantText([{ type: "step_finish", part: { type: "step-finish", text: "not-text" } }])).toBeUndefined();
  });

  it("returns undefined when there are no text parts", () => {
    expect(finalAssistantText([{ type: "noise" }])).toBeUndefined();
  });

  it("returns undefined when text parts are present but empty/whitespace", () => {
    expect(finalAssistantText([{ type: "text", part: { id: "p", type: "text", text: "   " } }])).toBeUndefined();
  });

  it("assigns distinct anonymous ids so id-less parts are not collapsed", () => {
    const objs: Array<Record<string, unknown>> = [
      { type: "text", part: { type: "text", text: "alpha" } },
      { type: "text", part: { type: "text", text: "beta" } },
    ];
    expect(finalAssistantText(objs)).toBe("alpha\nbeta");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSessionId — last-wins scan, both key spellings
// ─────────────────────────────────────────────────────────────────────────────
describe("extractSessionId", () => {
  it("returns the last event's session id (sessionID spelling)", () => {
    const objs = [{ sessionID: "ses_first" }, { type: "noise" }, { sessionID: "ses_last" }];
    expect(extractSessionId(objs)).toBe("ses_last");
  });

  it("accepts the sessionId spelling", () => {
    expect(extractSessionId([{ sessionId: "ses_alt" }])).toBe("ses_alt");
  });

  it("skips trailing events with no id and returns the last one that has it", () => {
    expect(extractSessionId([{ sessionID: "ses_x" }, { type: "trailing" }])).toBe("ses_x");
  });

  it("returns undefined when no event carries a session id", () => {
    expect(extractSessionId([{ type: "a" }, { type: "b" }])).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractUsage — sum tokens/cost, count steps, presence flags
// ─────────────────────────────────────────────────────────────────────────────
describe("extractUsage", () => {
  it("sums tokens + cost and counts step_finish events as turns", () => {
    const objs = parseJsonl(
      [
        '{"type":"step_finish","part":{"type":"step-finish","cost":0.001,"tokens":{"input":100,"output":10}}}',
        '{"type":"step_finish","part":{"type":"step-finish","cost":0.002,"tokens":{"input":50,"output":5}}}',
      ].join("\n"),
    );
    const usage = extractUsage(objs)!;
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(15);
    expect(usage.turns).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.003);
  });

  it("counts a top-level type:step_finish step", () => {
    const usage = extractUsage([{ type: "step_finish" }])!;
    expect(usage.turns).toBe(1);
  });

  it("counts a part.type step-finish step even when top-level type differs", () => {
    const usage = extractUsage([{ type: "message", part: { type: "step-finish", tokens: { input: 7 } } }])!;
    expect(usage.turns).toBe(1);
    expect(usage.inputTokens).toBe(7);
  });

  it("reports only the token fields actually present", () => {
    // Only output tokens present → no inputTokens key, no costUsd key.
    const usage = extractUsage([{ type: "step_finish", part: { type: "step-finish", tokens: { output: 9 } } }])!;
    expect(usage.outputTokens).toBe(9);
    expect("inputTokens" in usage).toBe(false);
    expect("costUsd" in usage).toBe(false);
    expect(usage.turns).toBe(1);
  });

  it("includes costUsd only when a cost is present", () => {
    const usage = extractUsage([{ type: "step_finish", part: { type: "step-finish", cost: 0.5 } }])!;
    expect(usage.costUsd).toBe(0.5);
  });

  it("ignores non-object tokens", () => {
    const usage = extractUsage([{ type: "step_finish", part: { type: "step-finish", tokens: "nope" } }])!;
    expect("inputTokens" in usage).toBe(false);
    expect("outputTokens" in usage).toBe(false);
    expect(usage.turns).toBe(1);
  });

  it("returns undefined when there are no step_finish events at all", () => {
    expect(extractUsage([{ type: "text", part: { type: "text", text: "hi" } }])).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractError — last error event, name/message extraction, edge shapes
// ─────────────────────────────────────────────────────────────────────────────
describe("extractError", () => {
  it("prefers the nested data.message over the top-level message", () => {
    const objs = parseJsonl(
      '{"type":"error","error":{"name":"APIError","message":"outer","data":{"message":"Rate limit exceeded"}}}',
    );
    expect(extractError(objs)).toEqual({ name: "APIError", message: "Rate limit exceeded" });
  });

  it("falls back to the top-level error.message when no data.message exists", () => {
    const objs = parseJsonl('{"type":"error","error":{"name":"Boom","message":"top only"}}');
    expect(extractError(objs)).toEqual({ name: "Boom", message: "top only" });
  });

  it("returns a default message when the error event carries no error object", () => {
    expect(extractError([{ type: "error" }])).toEqual({ message: "opencode reported an error" });
  });

  it("scans from the end and returns the last error event", () => {
    const objs = parseJsonl(
      [
        '{"type":"error","error":{"name":"First","data":{"message":"one"}}}',
        '{"type":"error","error":{"name":"Second","data":{"message":"two"}}}',
      ].join("\n"),
    );
    expect(extractError(objs)?.message).toBe("two");
  });

  it("returns undefined when no error event is present", () => {
    expect(extractError([{ type: "text" }, { type: "step_finish" }])).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatErrorEvent — name+message vs message-only vs name-only vs "Error"
// ─────────────────────────────────────────────────────────────────────────────
describe("formatErrorEvent", () => {
  it("prefixes a meaningful name onto the message", () => {
    expect(formatErrorEvent({ name: "APIError", message: "boom" })).toBe("APIError: boom");
  });

  it("drops the generic 'Error' name and returns the bare message", () => {
    expect(formatErrorEvent({ name: "Error", message: "boom" })).toBe("boom");
  });

  it("returns the message when there is no name", () => {
    expect(formatErrorEvent({ message: "just a message" })).toBe("just a message");
  });

  it("returns the name when there is no message", () => {
    expect(formatErrorEvent({ name: "OnlyName" })).toBe("OnlyName");
  });

  it("returns undefined for an undefined error", () => {
    expect(formatErrorEvent(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty error object", () => {
    const err: OpencodeError = {};
    expect(formatErrorEvent(err)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// re-exported cli helpers used through this module's surface
// ─────────────────────────────────────────────────────────────────────────────
describe("re-exported helpers", () => {
  it("cleanSummary collapses whitespace and caps at 280 with an ellipsis", () => {
    expect(cleanSummary("a\n\n  b   c")).toBe("a b c");
    const capped = cleanSummary("x".repeat(500));
    expect(capped.length).toBe(280);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("cleanSummary leaves a short string untouched", () => {
    expect(cleanSummary("short")).toBe("short");
  });

  it("lastMeaningfulLine drops timestamped log lines and returns the real one", () => {
    const stderr = ["2026-01-01T00:00:00.000Z ERROR noise", "real failure here"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
  });

  it("lastMeaningfulLine returns empty string when only noise remains", () => {
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z ERROR only noise")).toBe("");
  });

  it("parseJsonl skips non-JSON lines and keeps object lines", () => {
    expect(parseJsonl("log\n{\"a\":1}\nmore\n{\"b\":2}")).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonl("")).toEqual([]);
  });
});
