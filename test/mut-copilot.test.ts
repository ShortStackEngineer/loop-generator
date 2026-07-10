import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubCopilotDriver,
  parseJsonl,
  findResult,
  finalAssistantText,
  extractUsage,
  extractChangedFiles,
} from "../src/drivers/github-copilot";
import { silentLogger } from "../src/core/logger";
import type { AgentInvocation, AgentEvent } from "../src/drivers/types";

// A richer fake `copilot` CLI than the one in copilot-driver.test.ts. It is fully
// driven by env vars so a single binary can reproduce every reachable branch:
//   FAKE_VERSION_EXIT   exit code for `--version` (default 0)
//   FAKE_ARGV_OUT       file to dump argv (for arg-building assertions)
//   FAKE_RAW=1          use FAKE_STDOUT_B64/FAKE_STDERR_B64 verbatim (may be empty)
//   FAKE_STDOUT_B64     base64 raw stdout to emit verbatim (JSONL or noise)
//   FAKE_STDERR_B64     base64 raw stderr to emit verbatim
//   FAKE_EXIT           process exit code (default 0)
// Without FAKE_RAW it emits a canonical "completed" Copilot stream.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  const vx = Number(process.env.FAKE_VERSION_EXIT || "0");
  if (vx === 0) console.log("GitHub Copilot CLI 9.9.9-fake.");
  else process.stderr.write("version probe boom\n");
  process.exit(vx);
}
if (process.env.FAKE_ARGV_OUT) fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(args));
const b64 = (v) => Buffer.from(v || "", "base64").toString("utf8");
const exit = () => process.exit(Number(process.env.FAKE_EXIT || "0"));
if (process.env.FAKE_RAW === "1") {
  const out = b64(process.env.FAKE_STDOUT_B64);
  const err = b64(process.env.FAKE_STDERR_B64);
  let pending = 0;
  const maybeExit = () => { if (--pending <= 0) exit(); };
  pending = (out ? 1 : 0) + (err ? 1 : 0);
  if (!pending) exit();
  if (out) process.stdout.write(out, maybeExit);
  if (err) process.stderr.write(err, maybeExit);
} else {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  emit({ type: "assistant.message", data: { messageId: "m1", model: "gpt-5-mini", content: "All good.", outputTokens: 11 } });
  emit({ type: "assistant.turn_end", data: { turnId: "0" } });
  emit({ type: "result", sessionId: "sess-canon", exitCode: 0, usage: { codeChanges: { filesModified: [] } } });
  exit();
}
`;

let binDir: string;
let binPath: string;
let prevBin: string | undefined;
let prevGh: string | undefined;
let prevGithub: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "mutcopilot-bin-"));
  binPath = path.join(binDir, "copilot-fake.cjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
  prevBin = process.env.COPILOT_BIN;
  process.env.COPILOT_BIN = binPath;
  prevGh = process.env.GH_TOKEN;
  prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});
afterAll(() => {
  if (prevBin === undefined) delete process.env.COPILOT_BIN;
  else process.env.COPILOT_BIN = prevBin;
  if (prevGh === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = prevGh;
  if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = prevGithub;
  rmSync(binDir, { recursive: true, force: true });
});

// Each test controls token env explicitly and resets to "both unset" after.
afterEach(() => {
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "mutcopilot-wd-"));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

function invocation(over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    runId: "r",
    iteration: 0,
    workdir,
    prompt: "do the thing",
    options: {},
    log: silentLogger,
    ...over,
  };
}

/** Run the driver with a raw stdout/stderr/exit fixture (bypasses the file-writing path). */
async function runRaw(
  over: Partial<AgentInvocation> = {},
  fixture: { stdout?: string; stderr?: string; exit?: number } = {},
): Promise<{ result: Awaited<ReturnType<typeof githubCopilotDriver.run>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const env: Record<string, string> = {
    FAKE_RAW: "1",
    FAKE_STDOUT_B64: b64(fixture.stdout ?? ""),
    FAKE_STDERR_B64: b64(fixture.stderr ?? ""),
  };
  if (fixture.exit !== undefined) env.FAKE_EXIT = String(fixture.exit);
  const result = await githubCopilotDriver.run(
    invocation({ options: { env }, emit: (e) => events.push(e), ...over }),
  );
  return { result, events };
}

// ─── Driver metadata (L71-L72) ────────────────────────────────────────────────
describe("mut-copilot: metadata", () => {
  it("exposes the exact name and description", () => {
    expect(githubCopilotDriver.name).toBe("github-copilot");
    expect(githubCopilotDriver.description).toBe(
      "Invoke GitHub Copilot CLI in headless mode (copilot -p).",
    );
  });
});

// ─── Argv building: exact flag literals (L140,143-145,157) ────────────────────
describe("mut-copilot: argv building", () => {
  async function captureArgv(options: Record<string, unknown>, over: Partial<AgentInvocation> = {}): Promise<string[]> {
    const argvOut = path.join(workdir, "argv.json");
    await githubCopilotDriver.run(
      invocation({ options: { ...options, env: { ...(options.env as object), FAKE_ARGV_OUT: argvOut } }, ...over }),
    );
    return JSON.parse(readFileSync(argvOut, "utf8")) as string[];
  }

  it("emits the exact fixed headless flags in order", async () => {
    const argv = await captureArgv({});
    // -p <prompt> -C <workdir> --output-format json --no-color --no-ask-user --no-auto-update --log-level error
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe("do the thing");
    expect(argv[2]).toBe("-C");
    expect(argv[3]).toBe(workdir);
    expect(argv[4]).toBe("--output-format");
    expect(argv[5]).toBe("json");
    expect(argv[6]).toBe("--no-color");
    expect(argv[7]).toBe("--no-ask-user");
    expect(argv[8]).toBe("--no-auto-update");
    expect(argv[9]).toBe("--log-level");
    expect(argv[10]).toBe("error");
    // allowAllTools defaults true.
    expect(argv).toContain("--allow-all-tools");
  });

  it("folds systemPrompt in front of the prompt for -p", async () => {
    const argv = await captureArgv({}, { systemPrompt: "SYS", prompt: "ASK" });
    const pIdx = argv.indexOf("-p");
    expect(argv[pIdx + 1]).toBe("SYS\n\nASK");
  });

  it("passes model/effort with their exact flag names", async () => {
    const argv = await captureArgv({ model: "gpt-5", reasoningEffort: "medium" });
    const mIdx = argv.indexOf("--model");
    expect(argv[mIdx + 1]).toBe("gpt-5");
    const eIdx = argv.indexOf("--effort");
    expect(argv[eIdx + 1]).toBe("medium");
  });

  it("adds --resume=<id> only when resume AND a session id are both present", async () => {
    // Both present → flag present.
    const withBoth = await captureArgv({ resume: true }, { resumeSessionId: "S1" });
    expect(withBoth).toContain("--resume=S1");
    // resume true but no session id → omitted (LogicalOperator && boundary).
    const noId = await captureArgv({ resume: true });
    expect(noId.some((a) => a.startsWith("--resume"))).toBe(false);
    // session id present but resume false → omitted.
    const noResume = await captureArgv({ resume: false }, { resumeSessionId: "S1" });
    expect(noResume.some((a) => a.startsWith("--resume"))).toBe(false);
  });

  it("accepts and forwards every reasoningEffort enum member with the exact flag value", async () => {
    for (const eff of ["none", "low", "medium", "high", "xhigh", "max"]) {
      const argv = await captureArgv({ reasoningEffort: eff });
      const eIdx = argv.indexOf("--effort");
      expect(argv[eIdx + 1]).toBe(eff);
    }
  });

  it("does not add --resume when resume is left at its default (unset) even with a session id", async () => {
    // Kills `resume: default(false)` → `default(true)`: with resume unset and a
    // session id present, the default must be false so the flag is omitted.
    const argv = await captureArgv({}, { resumeSessionId: "S1" });
    expect(argv.some((a) => a.startsWith("--resume"))).toBe(false);
  });

  it("appends extraArgs only when non-empty", async () => {
    const withExtra = await captureArgv({ extraArgs: ["--x", "--y"] });
    expect(withExtra).toContain("--x");
    expect(withExtra).toContain("--y");
    const emptyExtra = await captureArgv({ extraArgs: [] });
    // Nothing extra appended; last fixed arg is still the log level value.
    expect(emptyExtra).not.toContain("--x");
  });

  it("omits --allow-all-tools when allowAllTools is false", async () => {
    const argv = await captureArgv({ allowAllTools: false });
    expect(argv).not.toContain("--allow-all-tools");
  });
});

// ─── run(): completed / garbage / fatal / auth / aborted (L113,176,179,194,203,208,221,234) ──
describe("mut-copilot: run() outcomes", () => {
  it("maps a canonical completed run with exact fields", async () => {
    const r = await githubCopilotDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("All good.");
    expect(r.sessionId).toBe("sess-canon");
    expect(r.usage).toEqual({ outputTokens: 11, turns: 1 });
    // raw carries the exact object count + effective exit code.
    const raw = r.raw as { objects: number; exitCode: number | null };
    expect(raw.objects).toBe(3);
    expect(raw.exitCode).toBe(0);
  });

  it("uses the exact fallback summary when there is no parseable final text", async () => {
    const { result } = await runRaw({}, { stdout: "not json\nstill not json\n", exit: 0 });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.summary).toBe("(copilot produced no parseable final summary; see report raw)");
  });

  it("returns aborted (exact) for an already-aborted signal before spawn", async () => {
    const r = await githubCopilotDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(r).toEqual({ ok: false, stopReason: "aborted", error: "aborted" });
  });

  it("prefers the process exit code over the result event exitCode when both present", async () => {
    // result says exit 0, process exits 7 → effectiveExit 7 → fatal.
    const stream =
      '{"type":"assistant.message","data":{"content":"hi","outputTokens":2}}\n' +
      '{"type":"result","sessionId":"s","exitCode":0}\n';
    const { result } = await runRaw({}, { stdout: stream, exit: 7 });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("error");
    const raw = result.raw as { exitCode: number | null };
    expect(raw.exitCode).toBe(7);
  });

  it("falls back to the result event exitCode when the process code is null-ish (exit 0, result non-zero)", async () => {
    // Process exits 0, but result.exitCode is 5 → not fatal (exit code wins = 0).
    const stream =
      '{"type":"assistant.message","data":{"content":"ok","outputTokens":1}}\n' +
      '{"type":"result","sessionId":"s","exitCode":5}\n';
    const { result } = await runRaw({}, { stdout: stream, exit: 0 });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
    const raw = result.raw as { exitCode: number | null };
    // exitCode (0) is present, so effectiveExit is 0, not the result's 5.
    expect(raw.exitCode).toBe(0);
  });

  it("treats a non-zero exit with no meaningful detail as a generic error string", async () => {
    const { result } = await runRaw({}, { stdout: "", stderr: "", exit: 3 });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("copilot CLI failed (exit 3)");
  });

  it("surfaces the last meaningful stderr line for a non-auth failure", async () => {
    const { result } = await runRaw(
      {},
      { stderr: "2026-01-01T00:00:00.000Z ERROR log noise\nreal boom line\n", exit: 2 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("real boom line");
  });

  it("uses the cleaned final assistant text as the error when stderr is only noise", async () => {
    // The JSON string must carry an escaped \n (backslash-n), not a real newline,
    // or parseJsonl would split the object across lines. cleanSummary collapses it.
    const stream =
      '{"type":"assistant.message","data":{"content":"tidy\\n\\n  reason","outputTokens":1}}\n' +
      '{"type":"result","exitCode":9}\n';
    const { result } = await runRaw({}, { stdout: stream, stderr: "", exit: 9 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tidy reason");
  });
});

// ─── Auth classification: the exact regex phrasings (L200,203,208) ────────────
describe("mut-copilot: auth error classification", () => {
  const authPhrases = [
    "not authenticated",
    "authentication failed",
    "authentication required",
    "please log in",
    "please login",
    "please sign in",
    "please signin",
    "gh auth login",
    "copilot login",
    "unauthorized",
    "unauthorised",
  ];
  for (const phrase of authPhrases) {
    it(`classifies "${phrase}" as an auth error with the actionable message`, async () => {
      // exit 0 so the ONLY reason it is fatal is the auth phrase (kills isAuthError branch).
      const { result } = await runRaw({}, { stderr: `Error: ${phrase} here.\n`, exit: 0 });
      expect(result.ok).toBe(false);
      expect(result.stopReason).toBe("error");
      expect(result.error).toBe(
        "GitHub Copilot authentication required — run `copilot` (or `gh auth login`) to sign in.",
      );
    });
  }

  it("matches auth phrases case-insensitively via the lowercased haystack", async () => {
    const { result } = await runRaw({}, { stderr: "NOT AUTHENTICATED\n", exit: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "GitHub Copilot authentication required — run `copilot` (or `gh auth login`) to sign in.",
    );
  });

  it("finds an auth phrase in stdout as well as stderr (both are searched)", async () => {
    const { result } = await runRaw({}, { stdout: "please sign in to continue\n", stderr: "", exit: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("authentication required");
  });

  it("does not classify an ordinary failure as auth (exit non-zero, no auth phrase)", async () => {
    const { result } = await runRaw({}, { stderr: "compilation failed\n", exit: 4 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("compilation failed");
    expect(result.error).not.toMatch(/authentication/i);
  });

  it("a clean exit 0 with no auth phrase is NOT fatal", async () => {
    // "authenticated fine" contains no matching phrase; run succeeds.
    const stream =
      '{"type":"assistant.message","data":{"content":"authenticated fine","outputTokens":1}}\n' +
      '{"type":"result","exitCode":0}\n';
    const { result } = await runRaw({}, { stdout: stream, exit: 0 });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
  });
});

// ─── run(): emitted error event on fatal (L213) ───────────────────────────────
describe("mut-copilot: fatal emits an error event", () => {
  it("emits a single error event carrying the resolved error message", async () => {
    const { result, events } = await runRaw({}, { stderr: "hard failure\n", exit: 1 });
    expect(result.ok).toBe(false);
    const errs = events.filter((e) => e.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({ kind: "error", message: "hard failure" });
  });
});

// ─── emitCopilotEvents: kinds, gating, turn numbering (L251,252,271,273) ──────
describe("mut-copilot: event emission", () => {
  it("emits model-message (turn+1) then turn-end (incremented turn), only for the right types", async () => {
    const stream = [
      '{"type":"assistant.message","data":{"content":"first"}}',
      '{"type":"assistant.turn_end","data":{}}',
      '{"type":"assistant.message","data":{"content":"second"}}',
      '{"type":"assistant.turn_end","data":{}}',
      '{"type":"other","data":{"content":"ignored"}}',
      '{"type":"result","exitCode":0}',
    ].join("\n");
    const { events } = await runRaw({}, { stdout: stream, exit: 0 });
    const traj = events.filter((e) => e.kind === "model-message" || e.kind === "turn-end");
    expect(traj).toEqual([
      { kind: "model-message", text: "first", turn: 1 },
      { kind: "turn-end", turn: 1 },
      { kind: "model-message", text: "second", turn: 2 },
      { kind: "turn-end", turn: 2 },
    ]);
  });

  it("does not emit a model-message when data is not an object", async () => {
    const stream = [
      '{"type":"assistant.message","data":"not-an-object"}',
      '{"type":"assistant.message","data":{"content":"real"}}',
      '{"type":"result","exitCode":0}',
    ].join("\n");
    const { events } = await runRaw({}, { stdout: stream, exit: 0 });
    const msgs = events.filter((e) => e.kind === "model-message");
    expect(msgs).toEqual([{ kind: "model-message", text: "real", turn: 1 }]);
  });

  it("does NOT emit a model-message for a non-message type even with object data+content", async () => {
    // Kills `type === "assistant.message" && isObject` → `||`: under || this
    // non-message object would leak a model-message; under && it must not.
    const stream = [
      '{"type":"tool.output","data":{"content":"should-not-leak"}}',
      '{"type":"result","exitCode":0}',
    ].join("\n");
    const { events } = await runRaw({}, { stdout: stream, exit: 0 });
    expect(events.filter((e) => e.kind === "model-message")).toEqual([]);
  });

  it("does not emit a model-message when content is empty/whitespace", async () => {
    const stream = [
      '{"type":"assistant.message","data":{"content":"   "}}',
      '{"type":"result","exitCode":0}',
    ].join("\n");
    const { events } = await runRaw({}, { stdout: stream, exit: 0 });
    expect(events.filter((e) => e.kind === "model-message")).toEqual([]);
  });

  it("ignores a turn_end look-alike type (exact equality on assistant.turn_end)", async () => {
    const stream = [
      '{"type":"assistant.turn_endX","data":{}}',
      '{"type":"result","exitCode":0}',
    ].join("\n");
    const { events } = await runRaw({}, { stdout: stream, exit: 0 });
    expect(events.filter((e) => e.kind === "turn-end")).toEqual([]);
  });
});

// ─── findResult: scans backwards, exact type match (L261) ─────────────────────
describe("mut-copilot: findResult", () => {
  it("returns the LAST result object when several are present", () => {
    const objs = parseJsonl(
      [
        '{"type":"result","sessionId":"early"}',
        '{"type":"assistant.message","data":{"content":"x"}}',
        '{"type":"result","sessionId":"late"}',
      ].join("\n"),
    );
    expect(findResult(objs)?.sessionId).toBe("late");
  });

  it("finds a result at index 0 (loop must include i===0)", () => {
    const objs: Record<string, unknown>[] = [{ type: "result", sessionId: "only" }];
    expect(findResult(objs)?.sessionId).toBe("only");
  });

  it("returns undefined when no result object exists", () => {
    expect(findResult([{ type: "assistant.message", data: {} }])).toBeUndefined();
  });
});

// ─── finalAssistantText: last non-empty content, gating (L271,273) ────────────
describe("mut-copilot: finalAssistantText", () => {
  it("returns the last assistant message with non-empty content", () => {
    const objs = parseJsonl(
      [
        '{"type":"assistant.message","data":{"content":"first"}}',
        '{"type":"assistant.message","data":{"content":"second"}}',
      ].join("\n"),
    );
    expect(finalAssistantText(objs)).toBe("second");
  });

  it("skips a trailing message whose content is empty and returns the earlier one", () => {
    const objs = parseJsonl(
      [
        '{"type":"assistant.message","data":{"content":"kept"}}',
        '{"type":"assistant.message","data":{"content":"   "}}',
      ].join("\n"),
    );
    expect(finalAssistantText(objs)).toBe("kept");
  });

  it("ignores assistant messages whose data is not an object", () => {
    const objs: Record<string, unknown>[] = [
      { type: "assistant.message", data: "nope" },
      { type: "assistant.message", data: { content: "yes" } },
    ];
    expect(finalAssistantText(objs)).toBe("yes");
  });

  it("returns undefined when no assistant message carries content", () => {
    expect(finalAssistantText([{ type: "result", exitCode: 0 }])).toBeUndefined();
  });
});

// ─── extractUsage: token summing, turn counting, gating (L285) ────────────────
describe("mut-copilot: extractUsage", () => {
  it("sums outputTokens across messages and counts turn_end boundaries", () => {
    const objs = parseJsonl(
      [
        '{"type":"assistant.message","data":{"content":"a","outputTokens":3}}',
        '{"type":"assistant.message","data":{"content":"b","outputTokens":4}}',
        '{"type":"assistant.turn_end","data":{}}',
        '{"type":"assistant.turn_end","data":{}}',
      ].join("\n"),
    );
    expect(extractUsage(objs)).toEqual({ outputTokens: 7, turns: 2 });
  });

  it("reports only turns when there are no output tokens", () => {
    const objs = parseJsonl('{"type":"assistant.turn_end","data":{}}');
    expect(extractUsage(objs)).toEqual({ turns: 1 });
  });

  it("reports only outputTokens when there are no turn_end events", () => {
    const objs = parseJsonl('{"type":"assistant.message","data":{"content":"a","outputTokens":5}}');
    expect(extractUsage(objs)).toEqual({ outputTokens: 5 });
  });

  it("counts a zero-token message as present (hasTokens), reporting outputTokens 0", () => {
    const objs = parseJsonl('{"type":"assistant.message","data":{"content":"a","outputTokens":0}}');
    expect(extractUsage(objs)).toEqual({ outputTokens: 0 });
  });

  it("ignores outputTokens when data is not an object", () => {
    const objs: Record<string, unknown>[] = [{ type: "assistant.message", data: 5 }];
    expect(extractUsage(objs)).toBeUndefined();
  });

  it("does NOT count outputTokens on a non-message type (kills && → ||)", () => {
    // Under the mutated `type === "assistant.message" || isObject(...)`, this
    // non-message object's 9 tokens would be summed; under `&&` they must not.
    const objs: Record<string, unknown>[] = [{ type: "tool.result", data: { outputTokens: 9 } }];
    expect(extractUsage(objs)).toBeUndefined();
  });

  it("ignores non-numeric outputTokens", () => {
    const objs: Record<string, unknown>[] = [
      { type: "assistant.message", data: { content: "a", outputTokens: "9" } },
    ];
    expect(extractUsage(objs)).toBeUndefined();
  });

  it("returns undefined for an empty / usage-free stream", () => {
    expect(extractUsage([])).toBeUndefined();
    expect(extractUsage([{ type: "other" }])).toBeUndefined();
  });
});

// ─── extractChangedFiles: relativize + gating (L305,306) ──────────────────────
describe("mut-copilot: extractChangedFiles", () => {
  it("relativizes absolute filesModified against the workdir", () => {
    const result = { type: "result", usage: { codeChanges: { filesModified: ["/w/src/a.ts", "/w/b.ts"] } } };
    expect(extractChangedFiles(result, "/w")).toEqual(["src/a.ts", "b.ts"]);
  });

  it("keeps a path unchanged when path.relative yields empty (identical to workdir)", () => {
    const result = { type: "result", usage: { codeChanges: { filesModified: ["/w"] } } };
    // path.relative("/w","/w") === "" → falls back to the original string.
    expect(extractChangedFiles(result, "/w")).toEqual(["/w"]);
  });

  it("drops non-string entries from filesModified", () => {
    const result = { type: "result", usage: { codeChanges: { filesModified: ["/w/a.ts", 42, null] } } };
    expect(extractChangedFiles(result, "/w")).toEqual(["a.ts"]);
  });

  it("returns undefined when filesModified is empty after filtering", () => {
    const result = { type: "result", usage: { codeChanges: { filesModified: [1, 2] } } };
    expect(extractChangedFiles(result, "/w")).toBeUndefined();
  });

  it("returns undefined when the result is absent", () => {
    expect(extractChangedFiles(undefined, "/w")).toBeUndefined();
  });

  it("returns undefined when codeChanges/filesModified are missing or malformed", () => {
    expect(extractChangedFiles({ type: "result" }, "/w")).toBeUndefined();
    expect(extractChangedFiles({ type: "result", usage: {} }, "/w")).toBeUndefined();
    expect(extractChangedFiles({ type: "result", usage: { codeChanges: {} } }, "/w")).toBeUndefined();
    expect(
      extractChangedFiles({ type: "result", usage: { codeChanges: { filesModified: "x" } } }, "/w"),
    ).toBeUndefined();
  });
});

// ─── preflight: notes, warnings, both token branches, probe failure (L82-L109) ─
describe("mut-copilot: preflight", () => {
  it("succeeds with the CLI-default model note when no model is set", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: (CLI default)");
    expect(pf.notes!.some((n) => n.startsWith("binary: "))).toBe(true);
    // Probe succeeds → NO version-probe warning (kills `if (true)` on the probe).
    expect((pf.warnings ?? []).some((s) => /"copilot --version" check had issues/.test(s))).toBe(false);
  });

  it("reports the configured model in the notes", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { model: "gpt-5" } });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toContain("model: gpt-5");
  });

  it("warns exactly once about allowAllTools being false", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { allowAllTools: false } });
    expect(pf.ok).toBe(true);
    const w = pf.warnings ?? [];
    expect(w.filter((s) => /allow-all-tools/.test(s))).toHaveLength(1);
  });

  it("does NOT warn about allowAllTools when it is left on (default true)", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect((pf.warnings ?? []).some((s) => /the Copilot CLI requires --allow-all-tools/.test(s))).toBe(false);
  });

  it("warns about missing tokens when neither GH_TOKEN nor GITHUB_TOKEN is set", async () => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect((pf.warnings ?? []).some((s) => /No GH_TOKEN\/GITHUB_TOKEN detected/.test(s))).toBe(true);
  });

  it("does NOT warn about tokens when GH_TOKEN is set", async () => {
    process.env.GH_TOKEN = "ghtok";
    delete process.env.GITHUB_TOKEN;
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect((pf.warnings ?? []).some((s) => /GH_TOKEN\/GITHUB_TOKEN/.test(s))).toBe(false);
  });

  it("does NOT warn about tokens when only GITHUB_TOKEN is set", async () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "ghtok";
    const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
    expect((pf.warnings ?? []).some((s) => /GH_TOKEN\/GITHUB_TOKEN/.test(s))).toBe(false);
  });

  it("warns when the `copilot --version` probe fails", async () => {
    const prev = process.env.FAKE_VERSION_EXIT;
    process.env.FAKE_VERSION_EXIT = "3";
    try {
      const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
      expect(pf.ok).toBe(true);
      expect((pf.warnings ?? []).some((s) => /"copilot --version" check had issues:/.test(s))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FAKE_VERSION_EXIT;
      else process.env.FAKE_VERSION_EXIT = prev;
    }
  });

  it("surfaces unknown option keys as warnings naming the github-copilot driver", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { bogusKey: 1 } });
    const w = pf.warnings ?? [];
    expect(w.some((s) => /does not recognize option\(s\): bogusKey/.test(s))).toBe(true);
    // The driver name is interpolated into the warning (kills the name → "" mutant).
    expect(w.some((s) => s.includes('driver "github-copilot"'))).toBe(true);
  });

  it("fails preflight with a driver-scoped message on invalid options", async () => {
    const pf = await githubCopilotDriver.preflight!({ workdir, options: { reasoningEffort: "turbo" } });
    expect(pf.ok).toBe(false);
    expect((pf.errors ?? []).some((s) => s.startsWith("github-copilot options: "))).toBe(true);
  });

  it("joins multiple option issues with '; ' inside the single error string", async () => {
    // Two invalid fields → two zod issues → mapped by (i) => i.message and joined
    // by "; " into one line. Kills the arrow-function and join-separator mutants.
    const pf = await githubCopilotDriver.preflight!({
      workdir,
      options: { model: 123, extraArgs: "not-an-array" },
    });
    expect(pf.ok).toBe(false);
    const line = (pf.errors ?? []).find((s) => s.startsWith("github-copilot options: "));
    expect(line).toBeDefined();
    // Non-empty messages on both sides of a "; " separator.
    const body = line!.replace("github-copilot options: ", "");
    const parts = body.split("; ");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((p) => p.trim().length > 0)).toBe(true);
  });

  it("fails preflight with the install hint when the copilot binary is missing", async () => {
    // Unset COPILOT_BIN and empty PATH so resolveBinary finds nothing.
    const prevBin = process.env.COPILOT_BIN;
    const prevPath = process.env.PATH;
    delete process.env.COPILOT_BIN;
    process.env.PATH = "";
    try {
      const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
      expect(pf.ok).toBe(false);
      expect(pf.errors).toEqual([
        'The "copilot" CLI was not found. Install GitHub Copilot CLI (e.g. `brew install copilot` or `npm i -g @github/copilot`), then run `copilot` once to authenticate.',
      ]);
    } finally {
      if (prevBin === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = prevBin;
      process.env.PATH = prevPath;
    }
  });

  it("includes the exact probe-error text (or 'unknown') in the version-check warning", async () => {
    // Pins `probe.error ?? "unknown"`: with a real probe failure the stderr body
    // is embedded; a mutant that blanks probe.error and the ?? fallback fails.
    const prev = process.env.FAKE_VERSION_EXIT;
    process.env.FAKE_VERSION_EXIT = "3";
    try {
      const pf = await githubCopilotDriver.preflight!({ workdir, options: {} });
      const w = (pf.warnings ?? []).find((s) => /"copilot --version" check had issues:/.test(s));
      expect(w).toBeDefined();
      // Fake binary writes "version probe boom" on non-zero --version.
      expect(w!).toMatch(/version probe boom|unknown|exit 3/);
      expect(w!.length).toBeGreaterThan('"copilot --version" check had issues: '.length);
    } finally {
      if (prev === undefined) delete process.env.FAKE_VERSION_EXIT;
      else process.env.FAKE_VERSION_EXIT = prev;
    }
  });
});

// ─── run(): missing binary / spawnError / mid-run abort (L119-124,176-181) ────
describe("mut-copilot: run() missing binary and spawn failures", () => {
  it("returns the exact not-installed error when no copilot binary is resolvable", async () => {
    const prevBin = process.env.COPILOT_BIN;
    const prevPath = process.env.PATH;
    delete process.env.COPILOT_BIN;
    process.env.PATH = "";
    try {
      const r = await githubCopilotDriver.run(invocation());
      expect(r).toEqual({
        ok: false,
        stopReason: "error",
        error:
          'The "copilot" CLI is not installed. Install GitHub Copilot CLI and authenticate with `copilot`.',
      });
    } finally {
      if (prevBin === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = prevBin;
      process.env.PATH = prevPath;
    }
  });

  it("returns spawnError text when COPILOT_BIN points at a non-existent binary", async () => {
    // resolveBinary trusts $COPILOT_BIN without probing; spawn then fails with ENOENT.
    const prevBin = process.env.COPILOT_BIN;
    process.env.COPILOT_BIN = path.join(workdir, "definitely-missing-copilot-binary");
    try {
      const r = await githubCopilotDriver.run(invocation());
      expect(r.ok).toBe(false);
      expect(r.stopReason).toBe("error");
      expect(typeof r.error).toBe("string");
      expect(r.error!.length).toBeGreaterThan(0);
      // Common Node spawn messages for missing binaries.
      expect(r.error!.toLowerCase()).toMatch(/enoent|not found|spawn|no such file/);
    } finally {
      if (prevBin === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = prevBin;
    }
  });

  it("returns aborted when the signal fires during a long-running spawn", async () => {
    // Slow fake: sleep then exit. Abort mid-flight → res.killed / signal.aborted.
    const slow = path.join(binDir, "copilot-slow.cjs");
    writeFileSync(
      slow,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("slow"); process.exit(0); }
setTimeout(() => process.exit(0), 30_000);
`,
    );
    chmodSync(slow, 0o755);
    const prevBin = process.env.COPILOT_BIN;
    process.env.COPILOT_BIN = slow;
    try {
      const ac = new AbortController();
      const pending = githubCopilotDriver.run(invocation({ signal: ac.signal }));
      // Give spawn a tick to start, then abort.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      const r = await pending;
      expect(r).toEqual({ ok: false, stopReason: "aborted", error: "aborted" });
    } finally {
      if (prevBin === undefined) delete process.env.COPILOT_BIN;
      else process.env.COPILOT_BIN = prevBin;
    }
  });
});
