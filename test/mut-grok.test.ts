import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  grokDriver,
  extractFinalText,
  extractUsage,
  extractSessionId,
  extractError,
  lastMeaningfulLine,
  cleanSummary,
} from "../src/drivers/grok";
import { silentLogger } from "../src/core/logger";
import type { AgentInvocation } from "../src/drivers/types";
import type { JsonObject } from "../src/drivers/cli";

// Reuse the same fake `grok` CLI harness as grok-driver.test.ts, extended with a
// couple of extra modes needed to reach still-surviving branches.
const FAKE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-grok 1.0.0"); process.exit(0); }
const fs = require("node:fs"); const path = require("node:path");
const cwdIdx = args.indexOf("--cwd");
const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
if (process.env.FAKE_GROK_ARGV_OUT) fs.writeFileSync(process.env.FAKE_GROK_ARGV_OUT, JSON.stringify(args));
// Record the child env of interest so tests can assert env-building.
if (process.env.FAKE_GROK_ENV_OUT) {
  fs.writeFileSync(process.env.FAKE_GROK_ENV_OUT, JSON.stringify({ GROK_HEADLESS: process.env.GROK_HEADLESS }));
}
const mode = process.env.FAKE_GROK_MODE || "completed";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (mode === "completed") {
  fs.writeFileSync(path.join(cwd, "GROK_EDIT.txt"), "edited");
  emit({ type: "assistant", role: "assistant", content: [{ text: "thinking out loud" }] });
  emit({ type: "result", subtype: "result", result: "Implemented the feature.",
        usage: { input_tokens: 12, output_tokens: 8, turns: 3 }, total_cost_usd: 0.03, session_id: "sess-xyz" });
  process.exit(0);
}
// max_turns but with NO parseable final text -> exercises the max_turns fallback summary.
if (mode === "maxturns_nofinal") {
  process.stderr.write("Error: max turns reached\n");
  process.exit(1);
}
// max_turns WITH a final result -> the summary should be the cleaned final text, exit 0.
if (mode === "maxturns_final") {
  emit({ type: "result", result: "Partial but real progress." });
  process.stderr.write("maximum turns\n");
  process.exit(0);
}
// completed, exit 0, with a structured error object present but not fatal (is_error false-y path).
if (mode === "fatal_structured") {
  emit({ type: "error", error: "structured boom", message: "ignored" });
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR noise line\n");
  process.stderr.write("plain stderr line\n");
  process.exit(3);
}
// fatal exit whose only stderr is noise AND no structured error -> generic fallback message.
if (mode === "fatal_noline") {
  process.stderr.write("2026-01-01T00:00:00.000Z ERROR only noise\n");
  process.exit(7);
}
// exit 0, empty stdout -> completed with the no-final fallback summary.
if (mode === "empty") { process.exit(0); }
// Each of these emits a single distinguishing stderr phrase then exits non-zero, so
// tests can pin exactly which alternation branch of the classifier regexes fires.
if (mode === "phrase") {
  process.stderr.write((process.env.FAKE_GROK_PHRASE || "") + "\n");
  process.exit(1);
}
// Same, but exit 0 so ONLY the auth/max-turns classifier (not the non-zero-exit
// fatal branch) can flip the outcome — isolates the classifier regexes.
if (mode === "phrase0") {
  process.stderr.write((process.env.FAKE_GROK_PHRASE || "") + "\n");
  process.exit(0);
}
process.exit(0);
`;

// A second fake CLI that reports a bad --version (non-zero) so the preflight
// "grok --version check had issues" warning path is exercised.
const FAKE_BADVERSION = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stderr.write("version probe broke\n"); process.exit(2); }
process.exit(0);
`;

let binDir: string;
let binPath: string;
let badVersionBin: string;
let prevBin: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "mutgrok-bin-"));
  binPath = path.join(binDir, "grok-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  badVersionBin = path.join(binDir, "grok-badversion.cjs");
  writeFileSync(badVersionBin, FAKE_BADVERSION);
  chmodSync(badVersionBin, 0o755);
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
  workdir = mkdtempSync(path.join(tmpdir(), "mutgrok-wd-"));
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

// ─── Driver identity + constant strings ──────────────────────────────────────

describe("grok driver identity & constants", () => {
  it("names and describes itself exactly", () => {
    expect(grokDriver.name).toBe("grok");
    expect(grokDriver.description).toBe("Invoke Grok Build via the grok CLI (headless -p).");
  });
});

// ─── Preflight branches ──────────────────────────────────────────────────────

describe("grok preflight branches", () => {
  it("fails on invalid options with a grok-prefixed message that includes the zod issue text", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: { maxTurns: -3 } });
    expect(pf.ok).toBe(false);
    const msg = pf.errors?.find((e) => e.startsWith("grok options:"));
    expect(msg).toBeDefined();
    // The mapped zod issue message must be present (kills map()->undefined and join("")).
    expect(msg).toMatch(/grok options: .+/);
    expect(msg!.length).toBeGreaterThan("grok options: ".length);
  });

  it("attributes the unknown-option warning to the 'grok' driver name", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: { totallyBogus: true } });
    expect(pf.warnings?.some((w) => w.includes('driver "grok" does not recognize'))).toBe(true);
  });

  it("warns with the exact phrasing when the --version probe fails, but still preflights ok", async () => {
    const prev = process.env.GROK_BIN;
    try {
      process.env.GROK_BIN = badVersionBin;
      const pf = await grokDriver.preflight!({ workdir, options: {} });
      expect(pf.ok).toBe(true);
      const w = pf.warnings?.find((x) => x.startsWith('"grok --version" check had issues: '));
      expect(w).toBeDefined();
      // probe.error surfaced (kills `?? "unknown"` -> `&& "unknown"` and -> `?? ""`).
      expect(w).toContain("version probe broke");
      expect(w).not.toBe('"grok --version" check had issues: ');
    } finally {
      process.env.GROK_BIN = prev!;
    }
  });

  it("does NOT emit the version-probe warning when the binary responds cleanly", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.warnings?.some((w) => w.startsWith('"grok --version" check had issues'))).toBe(false);
  });

  it("succeeds with a model note when a model is set", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: { model: "grok-build" } });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: grok-build");
    expect(pf.notes?.some((n) => n.startsWith("binary: "))).toBe(true);
  });

  it("uses the CLI-default model note when model is omitted", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: (CLI default)");
    expect(pf.notes).not.toContain("model: ");
  });

  it("warns about unknown options and preserves the exact phrasing", async () => {
    const pf = await grokDriver.preflight!({ workdir, options: { bogusKey: 1 } });
    expect(pf.ok).toBe(true);
    expect(pf.warnings?.some((w) => w.includes("does not recognize option(s): bogusKey"))).toBe(true);
  });

  it("warns when XAI_API_KEY is absent and does NOT warn when present", async () => {
    const prev = process.env.XAI_API_KEY;
    try {
      delete process.env.XAI_API_KEY;
      const without = await grokDriver.preflight!({ workdir, options: {} });
      expect(without.warnings?.some((w) => w.includes("No XAI_API_KEY detected."))).toBe(true);

      process.env.XAI_API_KEY = "xai-test-key";
      const withKey = await grokDriver.preflight!({ workdir, options: {} });
      expect(withKey.warnings?.some((w) => w.includes("No XAI_API_KEY detected."))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });
});

// ─── Run: env building, arg branches, summaries ──────────────────────────────

describe("grok run env & summaries", () => {
  it("sets GROK_HEADLESS=1 in the child environment", async () => {
    const envOut = path.join(workdir, "env.json");
    await grokDriver.run(
      invocation("completed", {
        options: { env: { FAKE_GROK_MODE: "completed", FAKE_GROK_ENV_OUT: envOut } },
      }),
    );
    const seen = JSON.parse(readFileSync(envOut, "utf8"));
    expect(seen.GROK_HEADLESS).toBe("1");
  });

  it("does not add --resume when resume is on but no resumeSessionId is present", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await grokDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      // resume:true but resumeSessionId omitted -> the && short-circuits, no flag.
      options: { env: { FAKE_GROK_MODE: "completed", FAKE_GROK_ARGV_OUT: argvOut }, resume: true },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--resume");
  });

  it("does not add --resume when a session id exists but resume is off", async () => {
    const argvOut = path.join(workdir, "argv.json");
    await grokDriver.run({
      runId: "r",
      iteration: 0,
      workdir,
      prompt: "p",
      resumeSessionId: "sess-1",
      options: { env: { FAKE_GROK_MODE: "completed", FAKE_GROK_ARGV_OUT: argvOut }, resume: false },
      log: silentLogger,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--resume");
  });

  it("uses the exact max_turns fallback summary when there is no final text", async () => {
    const r = await grokDriver.run(invocation("maxturns_nofinal"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
    expect(r.summary).toBe("agent reached its turn limit before finishing");
  });

  it("uses the cleaned final text as the summary on a max_turns run that produced one", async () => {
    const r = await grokDriver.run(invocation("maxturns_final"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
    expect(r.summary).toBe("Partial but real progress.");
  });

  it("uses the exact no-final fallback summary on a clean completed run with empty output", async () => {
    const r = await grokDriver.run(invocation("empty"));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("(grok produced no parseable final summary; see report raw)");
    // No error/model-message events, and no session/usage.
    expect(r.sessionId).toBeUndefined();
    expect(r.usage).toBeUndefined();
  });

  it("carries the exit code and object count in raw on a completed run", async () => {
    const r = await grokDriver.run(invocation("completed"));
    expect(r.raw).toMatchObject({ exitCode: 0, objects: 2 });
    expect(typeof (r.raw as Record<string, unknown>).stdout).toBe("string");
    expect(typeof (r.raw as Record<string, unknown>).stderr).toBe("string");
  });
});

// ─── Run: error classification & messages ────────────────────────────────────

describe("grok run error classification", () => {
  it("prefers a structured error object over a stderr line, and emits it", async () => {
    const events: Array<{ kind: string; message?: string }> = [];
    const r = await grokDriver.run(invocation("fatal_structured", { emit: (e) => events.push(e) }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toBe("structured boom");
    expect(events).toContainEqual({ kind: "error", message: "structured boom" });
    // Exit code surfaced in raw.
    expect((r.raw as Record<string, unknown>).exitCode).toBe(3);
  });

  it("falls back to a generic exit message when there is no structured error and only noise stderr", async () => {
    const r = await grokDriver.run(invocation("fatal_noline"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("grok CLI failed (exit 7)");
  });

  it("aborts (stopReason aborted, error 'aborted') for an already-aborted signal", async () => {
    const r = await grokDriver.run(invocation("completed", { signal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
    expect(r.error).toBe("aborted");
  });

  it("returns a spawnError (not aborted) when the binary path does not exist", async () => {
    const prev = process.env.GROK_BIN;
    try {
      process.env.GROK_BIN = path.join(binDir, "does-not-exist-grok.cjs");
      const r = await grokDriver.run(invocation("completed"));
      expect(r.ok).toBe(false);
      // spawnError branch: no stopReason set, just an error string.
      expect(r.stopReason).toBeUndefined();
      expect(typeof r.error).toBe("string");
      expect(r.error).toBeTruthy();
    } finally {
      process.env.GROK_BIN = prev!;
    }
  });
});

// ─── Classifier regexes (isolated from the non-zero-exit fatal branch) ───────

// Run the fake CLI so a single stderr phrase drives classification. `exit0`
// keeps the process exit at 0 so only the auth/max-turns REGEX can change the
// outcome (otherwise a non-zero exit would mark it fatal regardless).
async function classify(phrase: string, exit0: boolean) {
  return grokDriver.run(
    invocation(exit0 ? "phrase0" : "phrase", {
      options: { env: { FAKE_GROK_MODE: exit0 ? "phrase0" : "phrase", FAKE_GROK_PHRASE: phrase } },
    }),
  );
}

describe("grok max-turns regex", () => {
  it("matches the singular 'max turn reached' (the optional 's' in turns?)", async () => {
    const r = await classify("max turn reached", false);
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
  });

  it("matches the plural 'max turns reached'", async () => {
    const r = await classify("max turns reached", false);
    expect(r.stopReason).toBe("max_turns");
  });

  it("matches 'maximum turns' and 'maximum number of turns'", async () => {
    expect((await classify("maximum turns", false)).stopReason).toBe("max_turns");
    expect((await classify("maximum number of turns", false)).stopReason).toBe("max_turns");
  });
});

describe("grok auth regex (exit 0, so only the regex classifies)", () => {
  it("flags 'not authorized' (the [sz] char class covers z)", async () => {
    const r = await classify("not authorized", true);
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
  });

  it("flags 'not authorised' (the [sz] char class covers s)", async () => {
    expect((await classify("not authorised", true)).stopReason).toBe("error");
  });

  it("flags 'please login' and 'please log in' (the optional space in 'log ?in')", async () => {
    expect((await classify("please login", true)).stopReason).toBe("error");
    expect((await classify("please log in", true)).stopReason).toBe("error");
  });

  it("flags 'please signin' and 'please sign in' (the optional space in 'sign ?in')", async () => {
    expect((await classify("please signin", true)).stopReason).toBe("error");
    expect((await classify("please sign in", true)).stopReason).toBe("error");
  });

  it("flags 'xai_api_key not set' and 'xai_api_key is missing' (the optional 'is ')", async () => {
    expect((await classify("xai_api_key not set", true)).stopReason).toBe("error");
    expect((await classify("xai_api_key is missing", true)).stopReason).toBe("error");
  });

  it("does NOT flag an innocuous phrase on a clean exit (regex must not over-match)", async () => {
    const r = await classify("all good, task complete", true);
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
  });
});

// ─── extractFinalText branches ───────────────────────────────────────────────

describe("extractFinalText branches", () => {
  // These cases make the FIRST (result-event) loop win over a later object that
  // the SECOND loop would otherwise pick — the only way to kill the L241
  // type/subtype conditional & equality mutants.
  it("prefers a result-EVENT even when a later object has a response field the fallback would grab", () => {
    // Second loop scans backward and would return "later-response" first; only the
    // first loop's `type === "result"` match returns "event-answer" instead.
    expect(
      extractFinalText([
        { type: "result", result: "event-answer" },
        { response: "later-response" },
      ]),
    ).toBe("event-answer");
  });

  it("matches a result event via subtype (not type) and still beats a later fallback field", () => {
    expect(
      extractFinalText([
        { subtype: "result", result: "via-subtype" },
        { response: "later-response" },
      ]),
    ).toBe("via-subtype");
  });

  it("does NOT treat a non-result object as a result event (type must equal 'result')", () => {
    // No result-event exists. Correct behavior: fall through to the second loop,
    // which (scanning backward) returns the LAST object's response "Y".
    // An inverted `type !== "result"` mutant would make the first loop return the
    // earlier object's result "X" instead — so "Y" pins the equality.
    expect(
      extractFinalText([
        { type: "assistant", result: "X" },
        { type: "assistant", response: "Y" },
      ]),
    ).toBe("Y");
  });

  it("ignores a result-typed object whose result field is empty and falls through", () => {
    // type === "result" but result is blank -> asString() rejects it, so the
    // first loop must NOT return; the second loop finds the response field.
    expect(extractFinalText([{ type: "result", result: "   ", response: "second-field" }])).toBe(
      "second-field",
    );
  });

  it("prefers result over response over final over summary over text (nullish precedence)", () => {
    expect(
      extractFinalText([{ result: "R", response: "S", final: "F", summary: "M", text: "T" }]),
    ).toBe("R");
    expect(extractFinalText([{ response: "S", final: "F", summary: "M", text: "T" }])).toBe("S");
    expect(extractFinalText([{ final: "F", summary: "M", text: "T" }])).toBe("F");
    expect(extractFinalText([{ summary: "M", text: "T" }])).toBe("M");
    expect(extractFinalText([{ text: "T" }])).toBe("T");
  });

  it("requires role === 'assistant' AND an array content to join text parts", () => {
    // Right role but content is not an array -> no join, returns undefined.
    expect(extractFinalText([{ role: "assistant", content: "just a string" }])).toBeUndefined();
    // Array content but wrong role -> not joined.
    expect(extractFinalText([{ role: "user", content: [{ text: "hi" }] }])).toBeUndefined();
    // Both conditions met -> joined.
    expect(extractFinalText([{ role: "assistant", content: [{ text: "a" }, { text: "b" }] }])).toBe(
      "a\nb",
    );
  });

  it("filters out non-text content entries before joining (no stray blank lines)", () => {
    // A non-text part maps to undefined. With `.filter(Boolean)` the join is exactly
    // "keep" (2 real parts). Without the filter it would be "keep1\n\nkeep2" etc.
    expect(
      extractFinalText([
        { role: "assistant", content: [{ text: "keep1" }, { nope: 1 }, { text: "keep2" }] },
      ]),
    ).toBe("keep1\nkeep2");
  });

  it("joins string content entries and object text entries together", () => {
    expect(
      extractFinalText([{ role: "assistant", content: ["plain", { text: "obj" }] }]),
    ).toBe("plain\nobj");
  });

  it("returns undefined when the joined assistant content is only whitespace", () => {
    // The single text part is whitespace: `text` is truthy but `text.trim()` is
    // empty, so the guard must skip it (kills `if (text.trim())` -> `if (text)`).
    expect(
      extractFinalText([{ role: "assistant", content: [{ text: "   " }] }]),
    ).toBeUndefined();
  });

  it("scans from the last object backward for the result event", () => {
    const objs: JsonObject[] = [
      { type: "result", result: "first" },
      { type: "result", result: "last" },
    ];
    expect(extractFinalText(objs)).toBe("last");
  });
});

// ─── extractUsage branches ───────────────────────────────────────────────────

describe("extractUsage branches", () => {
  it("returns usage from a nested usage object", () => {
    expect(
      extractUsage([{ usage: { input_tokens: 5, output_tokens: 6, cost_usd: 0.1, turns: 4 } }]),
    ).toEqual({ inputTokens: 5, outputTokens: 6, costUsd: 0.1, turns: 4 });
  });

  it("returns usage when only total_cost_usd is present (no usage object)", () => {
    const u = extractUsage([{ total_cost_usd: 0.9 }]);
    expect(u).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: 0.9,
      turns: undefined,
    });
  });

  it("returns usage when only cost_usd is present", () => {
    expect(extractUsage([{ cost_usd: 0.25 }])?.costUsd).toBe(0.25);
  });

  it("returns usage when only num_turns is present (no usage, no cost)", () => {
    const u = extractUsage([{ num_turns: 11 }]);
    expect(u).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
      turns: 11,
    });
  });

  it("prefers total_cost_usd, then usage.cost_usd, then cost_usd", () => {
    expect(extractUsage([{ total_cost_usd: 1, cost_usd: 2, usage: { cost_usd: 3 } }])?.costUsd).toBe(1);
    expect(extractUsage([{ cost_usd: 2, usage: { cost_usd: 3 } }])?.costUsd).toBe(3);
    expect(extractUsage([{ cost_usd: 2 }])?.costUsd).toBe(2);
  });

  it("prefers top-level inputTokens/outputTokens fallbacks when usage lacks them", () => {
    const u = extractUsage([{ inputTokens: 100, outputTokens: 200, num_turns: 1 }]);
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 200 });
  });

  it("prefers usage.turns, then top-level turns, then num_turns", () => {
    expect(extractUsage([{ usage: { turns: 9 }, turns: 8, num_turns: 7 }])?.turns).toBe(9);
    expect(extractUsage([{ turns: 8, num_turns: 7 }])?.turns).toBe(8);
    expect(extractUsage([{ num_turns: 7 }])?.turns).toBe(7);
  });

  it("returns undefined when no usage-bearing object exists", () => {
    expect(extractUsage([{ nothing: 1 }, { still: "nope" }])).toBeUndefined();
  });

  it("scans backward, returning the most recent usage-bearing object", () => {
    expect(extractUsage([{ num_turns: 1 }, { num_turns: 2 }])?.turns).toBe(2);
  });
});

// ─── extractSessionId branches ───────────────────────────────────────────────

describe("extractSessionId branches", () => {
  it("reads session_id, falling back to sessionId", () => {
    expect(extractSessionId([{ session_id: "snake" }])).toBe("snake");
    expect(extractSessionId([{ sessionId: "camel" }])).toBe("camel");
  });

  it("prefers session_id over sessionId on the same object", () => {
    expect(extractSessionId([{ session_id: "snake", sessionId: "camel" }])).toBe("snake");
  });

  it("scans backward for the newest id", () => {
    expect(extractSessionId([{ session_id: "old" }, { session_id: "new" }])).toBe("new");
  });
});

// ─── extractError branches ───────────────────────────────────────────────────

describe("extractError branches", () => {
  it("matches type === 'error'", () => {
    expect(extractError([{ type: "error", message: "boom" }])).toBe("boom");
  });

  it("matches a truthy error field and returns it", () => {
    expect(extractError([{ error: "explicit error" }])).toBe("explicit error");
  });

  it("matches is_error and returns the message when error field is missing", () => {
    expect(extractError([{ is_error: true, message: "flagged" }])).toBe("flagged");
  });

  it("returns undefined when an error object has neither error nor message strings", () => {
    expect(extractError([{ is_error: true }])).toBeUndefined();
  });

  it("does not match a plain object without error markers", () => {
    expect(extractError([{ type: "assistant", text: "hi" }])).toBeUndefined();
  });

  it("scans backward for the latest error object", () => {
    expect(extractError([{ error: "old" }, { error: "new" }])).toBe("new");
  });
});

// ─── lastMeaningfulLine (grok-specific noise filter) ─────────────────────────

describe("grok lastMeaningfulLine noise filter", () => {
  it("drops grok MCP chatter lines while keeping real content", () => {
    const stderr = [
      "Skipping MCP tool: search",
      "tool_output_error occurred",
      "tool_error thrown",
      "the actual failure",
    ].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("the actual failure");
  });

  it("returns empty string when every line is MCP noise", () => {
    const stderr = ["Skipping MCP tool: a", "tool_output_error b", "tool_error c"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("");
  });

  it("still drops timestamped ERROR log lines (inherited base filter)", () => {
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z ERROR base noise")).toBe("");
  });
});

// ─── cleanSummary cap boundary ───────────────────────────────────────────────

describe("cleanSummary cap boundary", () => {
  it("leaves an under-cap string unchanged (length preserved, no ellipsis)", () => {
    const s = "a".repeat(279);
    const out = cleanSummary(s);
    expect(out).toBe(s);
    expect(out.length).toBe(279);
    expect(out.endsWith("…")).toBe(false);
  });

  it("leaves an exactly-at-cap string unchanged (length exactly 280)", () => {
    const s = "b".repeat(280);
    const out = cleanSummary(s);
    expect(out).toBe(s);
    expect(out.length).toBe(280);
  });

  it("caps an over-cap string to exactly 280 chars ending in an ellipsis", () => {
    const out = cleanSummary("c".repeat(281));
    expect(out.length).toBe(280);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 279)).toBe("c".repeat(279));
  });
});
