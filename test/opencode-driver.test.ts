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
} from "../src/drivers/opencode";
import { silentLogger } from "../src/core/logger";
import { runDriverConformance } from "../src/testing/conformance";
import type { AgentInvocation } from "../src/drivers/types";

// A fake `opencode` CLI: emits OpenCode-shaped JSONL or fails per FAKE_OPENCODE_MODE.
// In "completed" mode it parses the positional `run` message for a target file +
// exact contents and writes it under --dir (so it behaves like the real agentic
// CLI for conformance). `.cjs` so it runs as CommonJS regardless of "type":"module".
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("opencode 1.0.0-fake"); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
if (process.env.FAKE_OPENCODE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_OPENCODE_ARGV_OUT, JSON.stringify(args));
// message is the first positional after "run"; --dir carries the workspace.
const runIdx = args.indexOf("run");
const message = runIdx >= 0 ? args[runIdx + 1] : "";
const dIdx = args.indexOf("--dir");
const cwd = dIdx >= 0 ? args[dIdx + 1] : process.cwd();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = process.env.FAKE_OPENCODE_MODE || "completed";
const SES = "ses_fake1234567890";
if (mode === "model-error") {
  emit({ type: "error", timestamp: 1, sessionID: SES, error: { name: "APIError", data: { message: 'Invalid model identifier "nope".', statusCode: 400 } } });
  process.exit(1);
}
if (mode === "fatal") {
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR stacktrace noise\n");
  process.stderr.write("fatal: provider exploded\n");
  process.exit(2);
}
if (mode === "garbage") { process.stdout.write("just prose, not json\nmore prose\n"); process.exit(0); }
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
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-opencodebin-"));
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
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-opencode-"));
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

function withMode(mode: string, over: Partial<AgentInvocation> = {}): AgentInvocation {
  return invocation({ options: { env: { FAKE_OPENCODE_MODE: mode } }, ...over });
}

describe("opencode driver (fake CLI)", () => {
  it("maps a completed run: summary, usage, session, and a real edit", async () => {
    const r = await opencodeDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("Done.");
    expect(r.sessionId).toBe("ses_fake1234567890");
    expect(r.usage).toMatchObject({ inputTokens: 671, outputTokens: 8, turns: 1, costUsd: 0.001 });
    expect(readFileSync(path.join(workdir, "OUTPUT.txt"), "utf8")).toBe("hello123");
  });

  it("treats a provider/model error event as a failure with an actionable message", async () => {
    const r = await opencodeDriver.run(withMode("model-error"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/Invalid model identifier/);
  });

  it("treats a non-zero exit as fatal, surfacing the real error line (not log noise)", async () => {
    const r = await opencodeDriver.run(withMode("fatal"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/provider exploded/);
    expect(r.error).not.toMatch(/stacktrace noise/);
  });

  it("does not invent a summary from non-JSON output", async () => {
    const r = await opencodeDriver.run(withMode("garbage"));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no parseable final summary/i);
  });

  it("returns aborted for an already-aborted signal (no spawn)", async () => {
    const r = await opencodeDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
  });

  it("builds the expected CLI arguments", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await opencodeDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "build the thing",
      systemPrompt: "You are an expert.",
      resumeSessionId: "prev-sess",
      options: {
        env: { FAKE_OPENCODE_MODE: "completed", FAKE_OPENCODE_ARGV_OUT: argvOut },
        model: "lmstudio/qwen/qwen3-coder-next",
        agent: "build",
        variant: "high",
        pure: true,
        resume: true,
        extraArgs: ["--flag-x"],
      },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    const joined = argv.join(" ");
    expect(argv[0]).toBe("run");
    expect(joined).toContain("--dir " + workdir);
    expect(joined).toContain("--format json");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--pure");
    expect(joined).toContain("-m lmstudio/qwen/qwen3-coder-next");
    expect(joined).toContain("--agent build");
    expect(joined).toContain("--variant high");
    expect(joined).toContain("--session prev-sess");
    expect(argv).toContain("--flag-x");
    // systemPrompt is folded into the positional message (argv[1]).
    expect(argv[1]).toContain("You are an expert.");
    expect(argv[1]).toContain("build the thing");
  });

  it("omits optional flags when not configured", async () => {
    const argvOut = path.join(workdir, "argv2.json");
    await opencodeDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      options: { env: { FAKE_OPENCODE_MODE: "completed", FAKE_OPENCODE_ARGV_OUT: argvOut }, dangerouslySkipPermissions: false },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--pure");
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--agent");
    expect(argv).not.toContain("--variant");
    expect(argv).not.toContain("--session");
  });

  it("preflight succeeds when the binary responds", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
  });

  it("preflight warns when dangerouslySkipPermissions is disabled", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: { dangerouslySkipPermissions: false } });
    expect(pf.ok).toBe(true);
    expect((pf.warnings ?? []).join(" ")).toMatch(/dangerouslySkipPermissions|permission/i);
  });

  it("preflight fails on invalid options", async () => {
    const pf = await opencodeDriver.preflight!({ workdir, options: { model: 123 } });
    expect(pf.ok).toBe(false);
  });

  it("passes the driver conformance suite (offline, fake CLI)", async () => {
    const report = await runDriverConformance({ makeDriver: () => opencodeDriver });
    expect(report.passed).toBe(true);
  });
});

describe("opencode output helpers", () => {
  it("parses JSONL, skipping non-JSON lines", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonl('log line\n{"a":1}\nmore log\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("assembles assistant text and dedupes streamed snapshots by part id", () => {
    const objs = parseJsonl(
      [
        '{"type":"text","sessionID":"ses_x","part":{"id":"p1","type":"text","text":"Hel"}}',
        '{"type":"text","sessionID":"ses_x","part":{"id":"p1","type":"text","text":"Hello"}}',
        '{"type":"text","sessionID":"ses_x","part":{"id":"p2","type":"text","text":"world"}}',
      ].join("\n"),
    );
    // p1 keeps its latest snapshot ("Hello"), p2 is a distinct part.
    expect(finalAssistantText(objs)).toBe("Hello\nworld");
    expect(extractSessionId(objs)).toBe("ses_x");
  });

  it("sums token usage and counts steps across step_finish events", () => {
    const objs = parseJsonl(
      [
        '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"tool-calls","cost":0.001,"tokens":{"input":100,"output":10}}}',
        '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop","cost":0.002,"tokens":{"input":50,"output":5}}}',
      ].join("\n"),
    );
    expect(extractUsage(objs)).toMatchObject({ inputTokens: 150, outputTokens: 15, turns: 2 });
    expect(extractUsage(objs)?.costUsd).toBeCloseTo(0.003);
  });

  it("returns undefined usage/text/session/error when absent", () => {
    expect(extractUsage([{ type: "noise" }])).toBeUndefined();
    expect(finalAssistantText([{ type: "noise" }])).toBeUndefined();
    expect(extractSessionId([{ type: "noise" }])).toBeUndefined();
    expect(extractError([{ type: "noise" }])).toBeUndefined();
  });

  it("extracts and formats an error event", () => {
    const objs = parseJsonl(
      '{"type":"error","sessionID":"s","error":{"name":"APIError","data":{"message":"Rate limit exceeded"}}}',
    );
    expect(extractError(objs)).toMatchObject({ name: "APIError", message: "Rate limit exceeded" });
    expect(formatErrorEvent(extractError(objs))).toBe("APIError: Rate limit exceeded");
    expect(formatErrorEvent(undefined)).toBeUndefined();
  });

  it("cleanSummary collapses whitespace and caps length", () => {
    expect(cleanSummary("a\n\n  b   c")).toBe("a b c");
    expect(cleanSummary("x".repeat(500)).length).toBe(280);
  });

  it("lastMeaningfulLine drops timestamped logs", () => {
    const stderr = ["2026-01-01T00:00:00.000Z ERROR noise", "real failure here"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z ERROR only noise")).toBe("");
  });
});
