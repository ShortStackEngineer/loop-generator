import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubCopilotDriver,
  parseJsonl,
  findResult,
  finalAssistantText,
  extractUsage,
  extractChangedFiles,
  cleanSummary,
  lastMeaningfulLine,
} from "../src/drivers/github-copilot";
import { silentLogger } from "../src/core/logger";
import { runDriverConformance } from "../src/testing/conformance";
import type { AgentInvocation } from "../src/drivers/types";

// A fake `copilot` CLI: emits Copilot-shaped JSONL or fails per FAKE_COPILOT_MODE.
// In "completed" mode it parses the -p prompt for a target file + exact contents
// and writes it (so it behaves like the real agentic CLI for conformance). `.cjs`
// so it runs as CommonJS regardless of the repo's "type": "module".
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("GitHub Copilot CLI 1.0.0-fake."); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
if (process.env.FAKE_COPILOT_ARGV_OUT) fs.writeFileSync(process.env.FAKE_COPILOT_ARGV_OUT, JSON.stringify(args));
const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] : "";
const cIdx = args.indexOf("-C");
const cwd = cIdx >= 0 ? args[cIdx + 1] : process.cwd();
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = process.env.FAKE_COPILOT_MODE || "completed";
if (mode === "auth") { process.stderr.write("Error: not authenticated. Please sign in.\n"); process.exit(1); }
if (mode === "fatal") {
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR stacktrace noise\n");
  process.stderr.write("fatal: compiler exploded\n");
  process.exit(2);
}
if (mode === "garbage") { process.stdout.write("just prose, not json\nmore prose\n"); process.exit(0); }
const filesModified = [];
let file = "OUTPUT.txt";
const named = prompt.match(/file named (\S+)/) || prompt.match(/Update (\S+)/);
if (named) file = named[1];
const content = prompt.match(/exactly:\s*(\S+)/) || prompt.match(/containing\s+(\S+)/);
if (content) {
  const abs = path.resolve(cwd, file);
  fs.writeFileSync(abs, content[1]);
  filesModified.push(abs);
}
emit({ type: "assistant.message", data: { messageId: "m1", model: "gpt-5-mini", content: "Done.", outputTokens: 7 } });
emit({ type: "assistant.turn_end", data: { turnId: "0" } });
emit({ type: "result", sessionId: "copilot-sess-1", exitCode: 0, usage: { premiumRequests: 0, codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified } } });
process.exit(0);
`;

let binDir: string;
let binPath: string;
let prevBin: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-copilotbin-"));
  binPath = path.join(binDir, "copilot-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  prevBin = process.env.COPILOT_BIN;
  process.env.COPILOT_BIN = binPath;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.COPILOT_BIN;
  else process.env.COPILOT_BIN = prevBin;
  rmSync(binDir, { recursive: true, force: true });
});

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-copilot-"));
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
  return invocation({ options: { env: { FAKE_COPILOT_MODE: mode } }, ...over });
}

describe("github-copilot driver (fake CLI)", () => {
  it("maps a completed run: summary, usage, session, changed files, and a real edit", async () => {
    const r = await githubCopilotDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("Done.");
    expect(r.sessionId).toBe("copilot-sess-1");
    expect(r.usage).toMatchObject({ outputTokens: 7, turns: 1 });
    expect(r.changedFiles).toContain("OUTPUT.txt");
    expect(readFileSync(path.join(workdir, "OUTPUT.txt"), "utf8")).toBe("hello123");
  });

  it("treats auth failures as errors with a clean, actionable message", async () => {
    const r = await githubCopilotDriver.run(withMode("auth"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/authentication required|sign in/i);
  });

  it("treats a non-zero exit as fatal, surfacing the real error line (not log noise)", async () => {
    const r = await githubCopilotDriver.run(withMode("fatal"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/compiler exploded/);
    expect(r.error).not.toMatch(/stacktrace noise/);
  });

  it("does not invent a summary from non-JSON output", async () => {
    const r = await githubCopilotDriver.run(withMode("garbage"));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no parseable final summary/i);
  });

  it("returns aborted for an already-aborted signal (no spawn)", async () => {
    const r = await githubCopilotDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
  });

  it("builds the expected CLI arguments", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await githubCopilotDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "build the thing",
      systemPrompt: "You are an expert.",
      resumeSessionId: "prev-sess",
      options: {
        env: { FAKE_COPILOT_MODE: "completed", FAKE_COPILOT_ARGV_OUT: argvOut },
        model: "claude-sonnet-4.5",
        reasoningEffort: "high",
        resume: true,
        extraArgs: ["--flag-x"],
      },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    const joined = argv.join(" ");
    expect(argv).toContain("-p");
    expect(joined).toContain("-C " + workdir);
    expect(joined).toContain("--output-format json");
    expect(argv).toContain("--allow-all-tools");
    expect(argv).toContain("--no-ask-user");
    expect(joined).toContain("--model claude-sonnet-4.5");
    expect(joined).toContain("--effort high");
    expect(argv).toContain("--resume=prev-sess");
    expect(argv).toContain("--flag-x");
    // systemPrompt is folded into the -p prompt.
    const pIdx = argv.indexOf("-p");
    expect(argv[pIdx + 1]).toContain("You are an expert.");
    expect(argv[pIdx + 1]).toContain("build the thing");
  });

  it("omits optional flags when not configured", async () => {
    const argvOut = path.join(workdir, "argv2.json");
    await githubCopilotDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      options: { env: { FAKE_COPILOT_MODE: "completed", FAKE_COPILOT_ARGV_OUT: argvOut }, allowAllTools: false },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--allow-all-tools");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--effort");
    expect(argv.some((a) => a.startsWith("--resume"))).toBe(false);
  });

  it("preflight succeeds when the binary responds", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
  });

  it("preflight warns when allowAllTools is disabled", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { allowAllTools: false } });
    expect(pf.ok).toBe(true);
    expect((pf.warnings ?? []).join(" ")).toMatch(/allow-all-tools/);
  });

  it("preflight fails on invalid options", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { model: 123 } });
    expect(pf.ok).toBe(false);
  });

  it("passes the driver conformance suite (offline, fake CLI)", async () => {
    const report = await runDriverConformance({ makeDriver: () => githubCopilotDriver });
    expect(report.passed).toBe(true);
  });
});

describe("github-copilot output helpers", () => {
  it("parses JSONL, skipping non-JSON lines", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonl('log line\n{"a":1}\nmore log\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("finds the result event and the final assistant message", () => {
    const objs = parseJsonl(
      [
        '{"type":"assistant.message","data":{"content":"first","outputTokens":3}}',
        '{"type":"assistant.message","data":{"content":"second","outputTokens":4}}',
        '{"type":"assistant.turn_end","data":{"turnId":"0"}}',
        '{"type":"result","sessionId":"s1","exitCode":0,"usage":{"codeChanges":{"filesModified":["/w/a.txt"]}}}',
      ].join("\n"),
    );
    expect(findResult(objs)?.sessionId).toBe("s1");
    expect(finalAssistantText(objs)).toBe("second");
    expect(extractUsage(objs)).toMatchObject({ outputTokens: 7, turns: 1 });
    expect(extractChangedFiles(findResult(objs), "/w")).toEqual(["a.txt"]);
  });

  it("returns undefined usage/changes when absent", () => {
    expect(extractUsage([{ type: "noise" }])).toBeUndefined();
    expect(finalAssistantText([{ type: "noise" }])).toBeUndefined();
    expect(findResult([{ type: "noise" }])).toBeUndefined();
    expect(extractChangedFiles(undefined, "/w")).toBeUndefined();
    expect(extractChangedFiles({ type: "result" }, "/w")).toBeUndefined();
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
