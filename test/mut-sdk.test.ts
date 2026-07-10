import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeAgentSdkDriver,
  extractChangedFilesFromTranscript,
  CLAUDE_SDK_OPTION_KEYS,
  __setSdkLoaderForTests,
} from "../src/drivers/claude-agent-sdk";
import { silentLogger } from "../src/core/logger";
import type { AgentEvent, AgentInvocation } from "../src/drivers/types";

// ---------------------------------------------------------------------------
// Fake-SDK injection (same seam the existing sdk-driver test uses).
// ---------------------------------------------------------------------------

let captured: { prompt: string; options: Record<string, unknown> } | undefined;
const tmpDirs: string[] = [];

function fakeSdk(messages: Record<string, unknown>[], opts: { throwError?: Error } = {}) {
  return {
    query: (args: { prompt: string; options: Record<string, unknown> }) => {
      captured = args;
      return (async function* () {
        for (const m of messages) yield m;
        if (opts.throwError) throw opts.throwError;
      })();
    },
  };
}

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "loopgen-mutsdk-"));
  tmpDirs.push(dir);
  return dir;
}

function invocation(over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    runId: "r",
    iteration: 0,
    workdir: makeWorkdir(),
    prompt: "do it",
    options: {},
    log: silentLogger,
    ...over,
  };
}

// Snapshot/restore the auth env vars so hasAuth() tests are hermetic.
const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of AUTH_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  __setSdkLoaderForTests(null);
  captured = undefined;
  for (const k of AUTH_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// preflight — options schema, SDK-missing, unknown-option + auth warnings, notes.
// ---------------------------------------------------------------------------

describe("claude-agent-sdk preflight", () => {
  it("fails with the exact schema message on an invalid option", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({
      workdir: ".",
      // maxTurns must be a positive int — force a schema failure.
      options: { maxTurns: -1 },
    });
    expect(pf.ok).toBe(false);
    expect(pf.errors).toBeDefined();
    expect(pf.errors!.length).toBe(1);
    expect(pf.errors![0]).toMatch(/^claude-agent-sdk options: /);
  });

  it("does not consult the SDK loader when options are invalid", async () => {
    let loaderCalled = false;
    __setSdkLoaderForTests(async () => {
      loaderCalled = true;
      return fakeSdk([]);
    });
    const pf = await claudeAgentSdkDriver.preflight!({
      workdir: ".",
      options: { permissionMode: "not-a-mode" },
    });
    expect(pf.ok).toBe(false);
    expect(loaderCalled).toBe(false);
  });

  it("fails with the exact not-installed message when the SDK is absent", async () => {
    __setSdkLoaderForTests(async () => null);
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
    expect(pf.ok).toBe(false);
    expect(pf.errors).toEqual([
      'The optional dependency "@anthropic-ai/claude-agent-sdk" is not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    ]);
  });

  it("returns exact notes (model + permissionMode) with defaults and no warnings when auth present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toEqual(["model: claude-opus-4-8", "permissionMode: bypassPermissions"]);
    expect(pf.warnings).toEqual([]);
  });

  it("reflects provided model/permissionMode into the notes verbatim", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({
      workdir: ".",
      options: { model: "claude-custom", permissionMode: "plan" },
    });
    expect(pf.ok).toBe(true);
    expect(pf.notes).toEqual(["model: claude-custom", "permissionMode: plan"]);
  });

  it("adds the exact no-auth warning when no provider env is set", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
    expect(pf.ok).toBe(true);
    expect(pf.warnings).toEqual([
      "No ANTHROPIC_API_KEY (or alt provider env) detected. The SDK may rely on an interactive Claude login; set credentials for unattended runs.",
    ]);
  });

  it("does NOT add the no-auth warning when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
    expect(pf.warnings).toEqual([]);
    expect((pf.warnings ?? []).join("")).not.toMatch(/interactive Claude login/);
  });

  // Exercise every disjunct of hasAuth()'s OR chain individually so a single
  // dropped/flipped term is detectable (kills the L89 logical/conditional mutants).
  for (const key of AUTH_ENV_KEYS) {
    it(`treats ${key} alone as sufficient auth (no warning)`, async () => {
      process.env[key] = "1";
      __setSdkLoaderForTests(async () => fakeSdk([]));
      const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
      expect(pf.ok).toBe(true);
      expect(pf.warnings).toEqual([]);
    });
  }

  it("empty-string provider env values are NOT treated as auth", async () => {
    for (const k of AUTH_ENV_KEYS) process.env[k] = "";
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: {} });
    expect(pf.warnings).toEqual([
      "No ANTHROPIC_API_KEY (or alt provider env) detected. The SDK may rely on an interactive Claude login; set credentials for unattended runs.",
    ]);
  });

  it("carries unknown-option warnings alongside the no-auth warning (order preserved)", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({
      workdir: ".",
      options: { zzz: 1, aaa: 2 },
    });
    expect(pf.ok).toBe(true);
    expect(pf.warnings).toBeDefined();
    expect(pf.warnings!.length).toBe(2);
    // unknown-option warning first, then the auth warning.
    expect(pf.warnings![0]).toMatch(/does not recognize option\(s\): aaa, zzz/);
    expect(pf.warnings![1]).toMatch(/^No ANTHROPIC_API_KEY/);
  });

  it("exposes the exact set of known option keys", () => {
    expect([...CLAUDE_SDK_OPTION_KEYS]).toEqual([
      "model",
      "maxTurns",
      "permissionMode",
      "allowedTools",
      "disallowedTools",
      "resume",
      "queryOptions",
    ]);
  });

  // Each valid permissionMode enum member must round-trip verbatim into the
  // notes (kills the enum StringLiteral mutants); an unknown one must fail.
  for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan"] as const) {
    it(`accepts permissionMode "${mode}" and echoes it into the notes`, async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      __setSdkLoaderForTests(async () => fakeSdk([]));
      const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: { permissionMode: mode } });
      expect(pf.ok).toBe(true);
      expect(pf.notes).toEqual(["model: claude-opus-4-8", `permissionMode: ${mode}`]);
    });
  }

  it("rejects an unknown permissionMode value", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({
      workdir: ".",
      options: { permissionMode: "yolo" },
    });
    expect(pf.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run() — query option assembly (exact objects) + result mapping.
// ---------------------------------------------------------------------------

describe("claude-agent-sdk run: query options", () => {
  it("fails with the exact not-installed error and no stopReason when SDK absent", async () => {
    __setSdkLoaderForTests(async () => null);
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      '"@anthropic-ai/claude-agent-sdk" is not installed; cannot run the claude-agent-sdk driver.',
    );
    expect(r.stopReason).toBeUndefined();
  });

  it("passes the prompt through verbatim and builds default options", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    const inv = invocation({ prompt: "the-prompt" });
    await claudeAgentSdkDriver.run(inv);

    expect(captured!.prompt).toBe("the-prompt");
    expect(captured!.options).toEqual({
      cwd: inv.workdir,
      model: "claude-opus-4-8",
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    });
  });

  it("omits systemPrompt when not provided", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation());
    expect("systemPrompt" in captured!.options).toBe(false);
  });

  it("includes systemPrompt verbatim when provided", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation({ systemPrompt: "ROLE-TEXT" }));
    expect(captured!.options.systemPrompt).toBe("ROLE-TEXT");
  });

  it("omits disallowedTools when not provided", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation());
    expect("disallowedTools" in captured!.options).toBe(false);
  });

  it("includes disallowedTools verbatim when provided", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation({ options: { disallowedTools: ["Bash", "Write"] } }));
    expect(captured!.options.disallowedTools).toEqual(["Bash", "Write"]);
  });

  it("forwards resume=sessionId only when resume:true AND a resumeSessionId exists", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(
      invocation({ resumeSessionId: "sess-xyz", options: { resume: true } }),
    );
    expect(captured!.options.resume).toBe("sess-xyz");
  });

  it("does NOT forward resume when resume:true but no resumeSessionId", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation({ options: { resume: true } }));
    expect("resume" in captured!.options).toBe(false);
  });

  it("does NOT forward resume when a sessionId exists but resume:false", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation({ resumeSessionId: "sess-xyz", options: { resume: false } }));
    expect("resume" in captured!.options).toBe(false);
  });

  it("adds an abortController when a signal is present", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    const controller = new AbortController();
    await claudeAgentSdkDriver.run(invocation({ signal: controller.signal }));
    expect(captured!.options.abortController).toBeInstanceOf(AbortController);
  });

  it("omits abortController when no signal is present", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation());
    expect("abortController" in captured!.options).toBe(false);
  });

  it("passes an already-aborted controller through as aborted", async () => {
    let seen: AbortController | undefined;
    __setSdkLoaderForTests(async () => ({
      query: (args: { prompt: string; options: Record<string, unknown> }) => {
        seen = args.options.abortController as AbortController;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })();
      },
    }));
    await claudeAgentSdkDriver.run(invocation({ signal: AbortSignal.abort() }));
    expect(seen).toBeInstanceOf(AbortController);
    expect(seen!.signal.aborted).toBe(true);
  });

  it("propagates a downstream abort() to the derived controller", async () => {
    let seen: AbortController | undefined;
    __setSdkLoaderForTests(async () => ({
      query: (args: { prompt: string; options: Record<string, unknown> }) => {
        seen = args.options.abortController as AbortController;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })();
      },
    }));
    const controller = new AbortController();
    await claudeAgentSdkDriver.run(invocation({ signal: controller.signal }));
    expect(seen!.signal.aborted).toBe(false);
    controller.abort();
    expect(seen!.signal.aborted).toBe(true);
  });

  it("merges extra queryOptions verbatim into the options bag", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(
      invocation({ options: { queryOptions: { extraFlag: 7, tag: "hi" } } }),
    );
    expect(captured!.options.extraFlag).toBe(7);
    expect(captured!.options.tag).toBe("hi");
  });

  it("does not inject stray keys when queryOptions is absent", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    await claudeAgentSdkDriver.run(invocation());
    expect(Object.keys(captured!.options).sort()).toEqual([
      "allowedTools",
      "cwd",
      "maxTurns",
      "model",
      "permissionMode",
    ]);
  });
});

// ---------------------------------------------------------------------------
// run() — result mapping: summary, usage, session id, stopReason.
// ---------------------------------------------------------------------------

describe("claude-agent-sdk run: result mapping", () => {
  it("maps a success result to exact summary/usage/session/stopReason", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          subtype: "success",
          result: "implemented it",
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.02,
          num_turns: 4,
        },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("implemented it");
    expect(r.sessionId).toBe("sess-1");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.02, turns: 4 });
  });

  it("uses the placeholder summary when no result string is produced", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "system", subtype: "init", session_id: "s" }]));
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("(agent produced no final summary)");
    expect(r.usage).toBeUndefined();
  });

  it("maps usage with missing fields to undefined (not zero)", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "success", result: "ok" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
      turns: undefined,
    });
  });

  it("maps only the input token when only input_tokens is reported", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: { input_tokens: 42 },
        },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.usage!.inputTokens).toBe(42);
    expect(r.usage!.outputTokens).toBeUndefined();
  });

  it("does not capture a session id from a non-init system message", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "system", subtype: "other", session_id: "should-ignore" },
        { type: "result", subtype: "success", result: "ok" },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.sessionId).toBeUndefined();
  });

  it("does not capture a session id from an init system message lacking session_id", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "system", subtype: "init" },
        { type: "result", subtype: "success", result: "ok" },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.sessionId).toBeUndefined();
  });

  it("does not capture a session id from an assistant message carrying session_id", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        {
          type: "assistant",
          session_id: "leaked",
          message: { content: [{ type: "text", text: "hi" }] },
        },
        { type: "result", subtype: "success", result: "ok" },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.sessionId).toBeUndefined();
  });

  it("captures the session id only from the init system message when several carry one", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "system", subtype: "other", session_id: "wrong-a" },
        { type: "system", subtype: "init", session_id: "right" },
        { type: "result", subtype: "success", result: "ok", session_id: "wrong-b" },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.sessionId).toBe("right");
  });

  it("does not treat a non-string result field as the summary", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "success", result: 123 as unknown as string }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    // result present but not a string → placeholder summary, no usage captured.
    expect(r.summary).toBe("(agent produced no final summary)");
    expect(r.usage).toBeUndefined();
  });

  it("classifies error_max_turns as max_turns (still ok:true)", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "error_max_turns", result: "ran out" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
  });

  it("classifies a non-success, non-max_turns subtype as error (ok:false)", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "error_during_execution", result: "boom" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
  });

  it("treats a success subtype as completed (ok:true)", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "success", result: "done" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
  });

  it("treats an empty subtype as completed (not error)", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "", result: "done" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.stopReason).toBe("completed");
    expect(r.ok).toBe(true);
  });

  it("matches max_turns case-insensitively via lowercasing", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "ERROR_MAX_TURNS", result: "x" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.stopReason).toBe("max_turns");
  });

  it("returns the raw transcript on a completed run", async () => {
    const msgs = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok" },
    ];
    __setSdkLoaderForTests(async () => fakeSdk(msgs));
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.raw).toEqual(msgs);
  });

  it("omits changedFiles (undefined) when no write tools ran", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([{ type: "result", subtype: "success", result: "ok" }]),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.changedFiles).toBeUndefined();
  });

  it("returns a sorted changedFiles array from write tool inputs", async () => {
    const workdir = makeWorkdir();
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Write", input: { path: "zeta.ts" } },
              { type: "tool_use", id: "t2", name: "Edit", input: { path: "alpha.ts" } },
            ],
          },
        },
        { type: "result", subtype: "success", result: "done" },
      ]),
    );
    const r = await claudeAgentSdkDriver.run(invocation({ workdir }));
    expect(r.changedFiles).toEqual(["alpha.ts", "zeta.ts"]);
  });
});

// ---------------------------------------------------------------------------
// run() — throw / abort handling.
// ---------------------------------------------------------------------------

describe("claude-agent-sdk run: throw & abort", () => {
  it("classifies an unaborted throw as error and emits an error event with the message", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([], { throwError: new Error("stream boom") }));
    const events: AgentEvent[] = [];
    const r = await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toBe("stream boom");
    expect(events).toEqual([{ kind: "error", message: "stream boom" }]);
  });

  it("classifies a throw under an aborted signal as aborted and emits NO error event", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([], { throwError: new Error("stream failed") }));
    const events: AgentEvent[] = [];
    const r = await claudeAgentSdkDriver.run(
      invocation({ signal: AbortSignal.abort(), emit: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
    expect(r.error).toBe("stream failed");
    expect(events).toEqual([]);
  });

  it("classifies a throw whose message mentions abort as aborted even without a signal", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([], { throwError: new Error("The operation was Aborted") }),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.stopReason).toBe("aborted");
  });

  it("does not throw when emit is undefined on an unaborted error", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([], { throwError: new Error("no emitter") }));
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.error).toBe("no emitter");
  });

  it("preserves the partial transcript and session id captured before a throw", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk(
        [{ type: "system", subtype: "init", session_id: "sess-before-crash" }],
        { throwError: new Error("late boom") },
      ),
    );
    const r = await claudeAgentSdkDriver.run(invocation());
    expect(r.sessionId).toBe("sess-before-crash");
    expect(r.raw).toEqual([{ type: "system", subtype: "init", session_id: "sess-before-crash" }]);
  });
});

// ---------------------------------------------------------------------------
// emitSdkEvents (via run) — exact event stream, edge cases.
// ---------------------------------------------------------------------------

describe("claude-agent-sdk trajectory events", () => {
  it("emits the exact vendor-neutral event stream for a full turn", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "system", subtype: "init", session_id: "s" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "planning" },
              { type: "tool_use", id: "t1", name: "Write", input: { path: "a.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "wrote a.ts", is_error: false }] },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }] },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
        { type: "result", subtype: "success", result: "finished" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([
      { kind: "model-message", text: "planning", turn: 1 },
      { kind: "tool-call", name: "Write", id: "t1", turn: 1, input: { path: "a.ts" } },
      { kind: "tool-result", id: "t1", ok: true, turn: 1, output: "wrote a.ts" },
      { kind: "tool-result", id: "t2", ok: false, turn: 1, output: "boom" },
      { kind: "model-message", text: "done", turn: 2 },
    ]);
  });

  it("advances the turn counter only on assistant messages", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "one" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([
      { kind: "model-message", text: "one", turn: 1 },
      { kind: "tool-result", id: "x", ok: true, turn: 1, output: "r" },
      { kind: "model-message", text: "two", turn: 2 },
    ]);
  });

  it("falls back to 'unknown' for a tool_use block with a non-string name and undefined id", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: 123, input: { x: 1 } }] },
        },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([
      { kind: "tool-call", name: "unknown", id: undefined, turn: 1, input: { x: 1 } },
    ]);
  });

  it("treats a tool_result without is_error as ok:true, and a missing tool_use_id as undefined", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        { type: "user", message: { content: [{ type: "tool_result", content: "out" }] } },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([
      { kind: "model-message", text: "hi", turn: 1 },
      { kind: "tool-result", id: undefined, ok: true, turn: 1, output: "out" },
    ]);
  });

  it("treats a non-boolean-true is_error value as ok:true", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "z", content: "out", is_error: "yes" }] },
        },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events[1]).toEqual({ kind: "tool-result", id: "z", ok: true, turn: 1, output: "out" });
  });

  it("ignores non-record blocks and non-text/non-tool_use assistant blocks", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        {
          type: "assistant",
          message: {
            content: [
              "just-a-string",
              null,
              { type: "thinking", text: "hmm" },
              { type: "text", text: "kept" },
            ],
          },
        },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([{ kind: "model-message", text: "kept", turn: 1 }]);
  });

  it("does not emit a model-message when text is a non-string", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: 5 }] } },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([]);
  });

  it("still counts an assistant turn even with no emittable content", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [] } },
        { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([{ kind: "model-message", text: "second", turn: 2 }]);
  });

  it("ignores non-tool_result blocks in user messages", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
        {
          type: "user",
          message: { content: [{ type: "text", text: "user text" }, "raw"] },
        },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    expect(events).toEqual([{ kind: "model-message", text: "hi", turn: 1 }]);
  });

  it("emits nothing for an assistant message whose 'message' field is not a record", async () => {
    __setSdkLoaderForTests(async () =>
      fakeSdk([
        { type: "assistant", message: "not-a-record" },
        { type: "assistant", message: { content: [{ type: "text", text: "after" }] } },
        { type: "result", subtype: "success", result: "z" },
      ]),
    );
    const events: AgentEvent[] = [];
    await claudeAgentSdkDriver.run(invocation({ emit: (e) => events.push(e) }));
    // first assistant still counts as turn 1 (empty content), second is turn 2.
    expect(events).toEqual([{ kind: "model-message", text: "after", turn: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// extractChangedFilesFromTranscript & path helpers (pure).
// ---------------------------------------------------------------------------

describe("extractChangedFilesFromTranscript", () => {
  it("returns an empty array for an empty transcript", () => {
    expect(extractChangedFilesFromTranscript([], "/tmp/ws")).toEqual([]);
  });

  it("skips non-assistant messages entirely", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "user",
          message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/ws/x.ts" } }] },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("ignores an assistant message whose inner message is not a record", () => {
    const files = extractChangedFilesFromTranscript(
      [{ type: "assistant", message: 42 }],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("ignores an assistant message whose content is not an array", () => {
    const files = extractChangedFilesFromTranscript(
      [{ type: "assistant", message: { content: "nope" } }],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("relativizes an absolute path and dedupes across tool calls", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: "/tmp/ws/src/a.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "/tmp/ws/src/a.ts" } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["src/a.ts"]);
  });

  it("drops paths outside the workdir and paths from read-only tools", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: "/etc/passwd" } },
              { type: "tool_use", name: "Write", input: { file_path: "/tmp/ws/ok.ts" } },
              { type: "tool_use", name: "Read", input: { file_path: "/tmp/ws/skip.ts" } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["ok.ts"]);
  });

  it("accepts a tool matched by name regex (write|edit|replace) even if not in WRITE_TOOLS", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "custom_replace_tool", input: { path: "gen.ts" } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["gen.ts"]);
  });

  it("uses WRITE_TOOLS set membership for exact names not matching the regex", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "nb.ipynb" } }],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["nb.ipynb"]);
  });

  // `create_file` is the one WRITE_TOOLS member that the write|edit|replace
  // regex does NOT catch, so it exercises the set-membership path exclusively.
  it("recognizes the set-only tool name create_file (not matched by the regex)", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "create_file", input: { path: "made.ts" } }],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["made.ts"]);
  });

  it("ignores tool_use blocks whose name is not a write tool and does not match the regex", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { path: "cmd.ts" } }],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("ignores blocks that are not tool_use", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "no path here" },
              "raw-string",
              { type: "tool_use", name: "Write", input: { path: "real.ts" } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["real.ts"]);
  });

  it("collects paths from every supported input key", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Write", input: { filePath: "b.ts" } },
              { type: "tool_use", name: "Write", input: { path: "c.ts" } },
              { type: "tool_use", name: "Write", input: { file: "d.ts" } },
              { type: "tool_use", name: "Write", input: { notebook_path: "e.ipynb" } },
              { type: "tool_use", name: "Write", input: { notebookPath: "f.ipynb" } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ipynb", "f.ipynb"]);
  });

  it("trims surrounding whitespace and drops whitespace-only / non-string path values", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: "  spaced.ts  " } },
              { type: "tool_use", name: "Write", input: { path: "   " } },
              { type: "tool_use", name: "Write", input: { file: 123 } },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["spaced.ts"]);
  });

  it("collects file_path/filePath/path from MultiEdit-style edits[] entries", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "MultiEdit",
                input: {
                  edits: [
                    { file_path: "m1.ts" },
                    { filePath: "m2.ts" },
                    { path: "m3.ts" },
                    "not-a-record",
                    { file_path: "   " },
                    { file_path: 9 },
                  ],
                },
              },
            ],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["m1.ts", "m2.ts", "m3.ts"]);
  });

  it("returns nothing when tool input is not a record", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Write", input: "just-a-string" }] },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("ignores a workdir-relative '..' escape path", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Write", input: { path: "../escape.ts" } }] },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual([]);
  });

  it("resolves a bare relative path against the workdir", () => {
    const files = extractChangedFilesFromTranscript(
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Write", input: { path: "nested/dir/g.ts" } }] },
        },
      ],
      "/tmp/ws",
    );
    expect(files).toEqual(["nested/dir/g.ts"]);
  });
});
