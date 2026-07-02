import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cursorDriver,
  parseJsonObjects,
  findResultEvent,
  extractFinalText,
  extractUsage,
  extractSessionId,
  extractError,
  cleanSummary,
  lastMeaningfulLine,
} from "../src/drivers/cursor";
import { silentLogger } from "../src/core/logger";
import { runDriverConformance } from "../src/testing/conformance";
import type { AgentInvocation } from "../src/drivers/types";

// Fake `cursor` CLI: receives `agent` as first arg, emits Cursor-shaped JSON or
// fails per FAKE_CURSOR_MODE. In "completed" mode it parses the -p prompt for a
// target file + exact contents and writes it (agentic CLI behavior).
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "agent") { process.stderr.write("expected agent subcommand\n"); process.exit(1); }
const agentArgs = args.slice(1);
if (agentArgs.includes("-v")) { console.log("fake-cursor-agent 1.0.0"); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
if (process.env.FAKE_CURSOR_ARGV_OUT) fs.writeFileSync(process.env.FAKE_CURSOR_ARGV_OUT, JSON.stringify(agentArgs));
const pIdx = agentArgs.indexOf("-p");
const prompt = pIdx >= 0 ? agentArgs[pIdx + 1] : "";
const wIdx = agentArgs.indexOf("--workspace");
const cwd = wIdx >= 0 ? agentArgs[wIdx + 1] : process.cwd();
const mode = process.env.FAKE_CURSOR_MODE || "completed";
if (mode === "auth") { process.stderr.write("Error: not authenticated. Please sign in.\n"); process.exit(1); }
if (mode === "fatal") {
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR stacktrace noise\n");
  process.stderr.write("fatal: compiler exploded\n");
  process.exit(2);
}
if (mode === "max_turns") {
  process.stderr.write("Error: max turns reached\n");
  process.exit(1);
}
if (mode === "garbage") { process.stdout.write("just prose, not json\n"); process.exit(0); }
let file = "OUTPUT.txt";
const named = prompt.match(/file named (\S+)/) || prompt.match(/Update (\S+)/);
if (named) file = named[1];
const content = prompt.match(/exactly:\s*(\S+)/) || prompt.match(/containing\s+(\S+)/);
if (content) {
  fs.writeFileSync(path.resolve(cwd, file), content[1]);
}
const resultText = mode === "completed" ? "Done." : "partial";
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: mode === "completed" ? "success" : "error",
  is_error: mode !== "completed",
  result: resultText,
  session_id: "cursor-sess-1",
  usage: { inputTokens: 10, outputTokens: 5 },
}) + "\n");
process.exit(mode === "completed" ? 0 : 1);
`;

let binDir: string;
let binPath: string;
let prevBin: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-cursorbin-"));
  binPath = path.join(binDir, "cursor-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  prevBin = process.env.CURSOR_BIN;
  process.env.CURSOR_BIN = binPath;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.CURSOR_BIN;
  else process.env.CURSOR_BIN = prevBin;
  rmSync(binDir, { recursive: true, force: true });
});

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-cursor-"));
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
  return invocation({ options: { env: { FAKE_CURSOR_MODE: mode } }, ...over });
}

describe("cursor driver (fake CLI)", () => {
  it("maps a completed run: summary, usage, session, and a real edit", async () => {
    const r = await cursorDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("Done.");
    expect(r.sessionId).toBe("cursor-sess-1");
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(readFileSync(path.join(workdir, "OUTPUT.txt"), "utf8")).toBe("hello123");
  });

  it("treats auth failures as errors with a clean, actionable message", async () => {
    const r = await cursorDriver.run(withMode("auth"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/authentication required|sign in/i);
  });

  it("treats a non-zero exit as fatal, surfacing the real error line", async () => {
    const r = await cursorDriver.run(withMode("fatal"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/compiler exploded/);
  });

  it("treats max turns as incomplete success", async () => {
    const r = await cursorDriver.run(withMode("max_turns"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
  });

  it("does not invent a summary from non-JSON output", async () => {
    const r = await cursorDriver.run(withMode("garbage"));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no parseable final summary/i);
  });

  it("returns aborted for an already-aborted signal", async () => {
    const r = await cursorDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
  });

  it("builds the expected CLI arguments", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await cursorDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "build the thing",
      systemPrompt: "You are an expert.",
      resumeSessionId: "prev-sess",
      options: {
        env: { FAKE_CURSOR_MODE: "completed", FAKE_CURSOR_ARGV_OUT: argvOut },
        model: "sonnet-4",
        resume: true,
        extraArgs: ["--flag-x"],
      },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    const joined = argv.join(" ");
    expect(argv).toContain("-p");
    expect(joined).toContain("--workspace " + workdir);
    expect(joined).toContain("--output-format json");
    expect(argv).toContain("--force");
    expect(argv).toContain("--trust");
    expect(joined).toContain("--model sonnet-4");
    expect(argv).toContain("--resume");
    expect(argv).toContain("prev-sess");
    expect(argv).toContain("--flag-x");
    const pIdx = argv.indexOf("-p");
    expect(argv[pIdx + 1]).toContain("You are an expert.");
    expect(argv[pIdx + 1]).toContain("build the thing");
  });

  it("omits optional flags when not configured", async () => {
    const argvOut = path.join(workdir, "argv2.json");
    await cursorDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      options: {
        env: { FAKE_CURSOR_MODE: "completed", FAKE_CURSOR_ARGV_OUT: argvOut },
        force: false,
        trust: false,
      },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--trust");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--resume");
  });

  it("preflight succeeds when the binary responds", async () => {
    const pf = await cursorDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
  });

  it("preflight warns when force is disabled", async () => {
    const pf = await cursorDriver.preflight!({ workdir, options: { force: false } });
    expect(pf.ok).toBe(true);
    expect((pf.warnings ?? []).join(" ")).toMatch(/--force/);
  });

  it("preflight fails on invalid options", async () => {
    const pf = await cursorDriver.preflight!({ workdir, options: { model: 123 } });
    expect(pf.ok).toBe(false);
  });

  it("passes the driver conformance suite (offline, fake CLI)", async () => {
    const report = await runDriverConformance({ makeDriver: () => cursorDriver });
    expect(report.passed).toBe(true);
  });
});

describe("cursor output helpers", () => {
  it("parses JSON object or JSONL", () => {
    expect(parseJsonObjects("")).toEqual([]);
    expect(parseJsonObjects('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonObjects('log\n{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("finds result events and extracts fields", () => {
    const objs = parseJsonObjects(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Created file.",
        session_id: "s1",
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    );
    expect(findResultEvent(objs)?.subtype).toBe("success");
    expect(extractFinalText(objs)).toBe("Created file.");
    expect(extractSessionId(objs)).toBe("s1");
    expect(extractUsage(objs)).toMatchObject({ inputTokens: 3, outputTokens: 4 });
  });

  it("extracts errors from result events", () => {
    const objs = parseJsonObjects(JSON.stringify({ type: "result", is_error: true, result: "boom" }));
    expect(extractError(objs)).toBe("boom");
  });

  it("cleanSummary collapses whitespace and caps length", () => {
    expect(cleanSummary("a\n\n  b   c")).toBe("a b c");
    expect(cleanSummary("x".repeat(500)).length).toBe(280);
  });

  it("lastMeaningfulLine drops timestamped logs", () => {
    const stderr = ["2026-01-01T00:00:00.000Z ERROR noise", "real failure here"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
  });
});
