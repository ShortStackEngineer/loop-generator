import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  grokDriver,
  parseJsonObjects,
  extractFinalText,
  extractUsage,
  extractSessionId,
  extractError,
  lastMeaningfulLine,
  cleanSummary,
} from "../src/drivers/grok";
import { silentLogger } from "../src/core/logger";
import { readFileSync } from "node:fs";
import type { AgentInvocation } from "../src/drivers/types";

// A fake `grok` CLI: emits JSONL or fails per FAKE_GROK_MODE. `.cjs` so it runs
// as CommonJS regardless of the repo's "type": "module".
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-grok 1.0.0"); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
const cwdIdx = args.indexOf("--cwd");
const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
// Record the argv we were invoked with so tests can assert arg-building.
if (process.env.FAKE_GROK_ARGV_OUT) fs.writeFileSync(process.env.FAKE_GROK_ARGV_OUT, JSON.stringify(args));
const mode = process.env.FAKE_GROK_MODE || "completed";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (mode === "completed") {
  fs.writeFileSync(path.join(cwd, "GROK_EDIT.txt"), "edited");
  emit({ type: "assistant", role: "assistant", content: [{ text: "thinking out loud" }] });
  emit({ type: "result", subtype: "result", result: "Implemented the feature.",
        usage: { input_tokens: 12, output_tokens: 8, turns: 3 }, total_cost_usd: 0.03, session_id: "sess-xyz" });
  process.exit(0);
}
if (mode === "max_turns") {
  emit({ type: "assistant", role: "assistant", content: [{ text: "partial work" }] });
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR tool_error noise\n");
  process.stderr.write("Error: max turns reached\n");
  process.exit(1);
}
if (mode === "auth") { process.stderr.write("Error: not authorized - please log in\n"); process.exit(1); }
if (mode === "fatal") {
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR stacktrace noise\n");
  process.stderr.write("fatal: compiler exploded\n");
  process.exit(2);
}
if (mode === "garbage") { process.stdout.write("ne, just prose, not json\nmore prose\n"); process.exit(0); }
if (mode === "maxturns_alt") { process.stderr.write("hit the maximum number of turns\n"); process.exit(1); }
if (mode === "auth_alt") { process.stderr.write("invalid api key provided\n"); process.exit(1); }
process.exit(0);
`;

let binDir: string;
let binPath: string;
let prevBin: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-grokbin-"));
  binPath = path.join(binDir, "grok-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  prevBin = process.env.GROK_BIN;
  process.env.GROK_BIN = binPath;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.GROK_BIN;
  else process.env.GROK_BIN = prevBin;
  rmSync(binDir, { recursive: true, force: true });
});

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "loopgen-grok-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function invocation(mode: string, over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    runId: "r",
    iteration: 0,
    workdir,
    prompt: "do it",
    options: { env: { FAKE_GROK_MODE: mode } },
    log: silentLogger,
    ...over,
  };
}

describe("grok driver (fake CLI)", () => {
  it("maps a completed run: summary, usage, session, and a real edit", async () => {
    const r = await grokDriver.run(invocation("completed"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("Implemented the feature.");
    expect(r.sessionId).toBe("sess-xyz");
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, turns: 3, costUsd: 0.03 });
    expect(existsSync(path.join(workdir, "GROK_EDIT.txt"))).toBe(true);
  });

  it("classifies max_turns (non-zero exit) as incomplete, not a crash", async () => {
    const r = await grokDriver.run(invocation("max_turns"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
  });

  it("treats auth failures as errors with a clean message (no log noise)", async () => {
    const r = await grokDriver.run(invocation("auth"));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/not authorized|log in/i);
    expect(r.error).not.toMatch(/tool_error|ERROR/);
  });

  it("treats a non-zero exit as fatal, surfacing the real error line", async () => {
    const r = await grokDriver.run(invocation("fatal"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/compiler exploded/);
    expect(r.error).not.toMatch(/stacktrace noise/);
  });

  it("recognizes alternate max-turns and auth phrasings", async () => {
    const mt = await grokDriver.run(invocation("maxturns_alt"));
    expect(mt.ok).toBe(true);
    expect(mt.stopReason).toBe("max_turns");

    const auth = await grokDriver.run(invocation("auth_alt"));
    expect(auth.ok).toBe(false);
    expect(auth.error).toMatch(/invalid api key/i);
  });

  it("does not invent a summary from a raw reasoning dump", async () => {
    const r = await grokDriver.run(invocation("garbage"));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/no parseable final summary/i);
  });

  it("returns aborted for an already-aborted signal", async () => {
    const r = await grokDriver.run(invocation("completed", { signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
  });

  it("preflight succeeds when the binary responds", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
  });

  it("builds the expected CLI arguments", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await grokDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "build the thing",
      systemPrompt: "You are an expert.",
      resumeSessionId: "prev-sess",
      options: {
        env: { FAKE_GROK_MODE: "completed", FAKE_GROK_ARGV_OUT: argvOut },
        model: "grok-build",
        maxTurns: 7,
        resume: true,
        extraArgs: ["--flag-x"],
      },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    const joined = argv.join(" ");
    expect(argv).toContain("-p");
    expect(joined).toContain("--cwd " + workdir);
    expect(joined).toContain("--output-format json");
    expect(argv).toContain("--always-approve");
    expect(joined).toContain("-m grok-build");
    expect(joined).toContain("--max-turns 7");
    expect(joined).toContain("--resume prev-sess");
    expect(argv).toContain("--flag-x");
    // systemPrompt is folded into the -p prompt.
    const pIdx = argv.indexOf("-p");
    expect(argv[pIdx + 1]).toContain("You are an expert.");
    expect(argv[pIdx + 1]).toContain("build the thing");
  });

  it("omits optional flags when not configured", async () => {
    const argvOut = path.join(workdir, "argv2.json");
    await grokDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      options: { env: { FAKE_GROK_MODE: "completed", FAKE_GROK_ARGV_OUT: argvOut }, alwaysApprove: false },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--always-approve");
    expect(argv).not.toContain("-m");
    expect(argv).not.toContain("--max-turns");
    expect(argv).not.toContain("--resume");
  });
});

describe("grok output helpers", () => {
  it("parses JSONL and a single object, skipping non-JSON lines", () => {
    expect(parseJsonObjects("")).toEqual([]);
    expect(parseJsonObjects('{"a":1}')).toEqual([{ a: 1 }]);
    const objs = parseJsonObjects('not json\n{"a":1}\nalso not\n{"b":2}');
    expect(objs).toEqual([{ a: 1 }, { b: 2 }]);
    // top-level array is flattened
    expect(parseJsonObjects('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("prefers a result event, then assistant content", () => {
    expect(
      extractFinalText([{ type: "assistant", role: "assistant", content: [{ text: "mid" }] }, { type: "result", result: "final" }]),
    ).toBe("final");
    expect(extractFinalText([{ role: "assistant", content: ["hello", { text: "world" }] }])).toBe("hello\nworld");
    expect(extractFinalText([{ nothing: true }])).toBeUndefined();
  });

  it("extracts usage, session, and error from the right object", () => {
    const objs = [
      { type: "system", session_id: "s9" },
      { usage: { input_tokens: 3, output_tokens: 4, turns: 2 }, total_cost_usd: 0.5 },
    ];
    expect(extractUsage(objs)).toMatchObject({ inputTokens: 3, outputTokens: 4, turns: 2, costUsd: 0.5 });
    expect(extractSessionId(objs)).toBe("s9");
    expect(extractUsage([{ no: "usage" }])).toBeUndefined();
    expect(extractSessionId([{ no: "id" }])).toBeUndefined();
    expect(extractError([{ type: "error", error: "kaboom" }])).toBe("kaboom");
    expect(extractError([{ is_error: true, message: "msg" }])).toBe("msg");
    expect(extractError([{ ok: true }])).toBeUndefined();
  });

  it("lastMeaningfulLine drops timestamped logs and MCP noise", () => {
    const stderr = [
      "2026-01-01T00:00:00.000Z ERROR something happened",
      "Skipping MCP tool: foo",
      "tool_output_error blah",
      "real failure here",
    ].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z ERROR only noise")).toBe("");
  });

  it("cleanSummary collapses and caps", () => {
    expect(cleanSummary("a\n\n  b   c")).toBe("a b c");
    expect(cleanSummary("x".repeat(500)).length).toBe(280);
  });
});
