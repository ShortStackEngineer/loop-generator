import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeAgentSdkDriver, __setSdkLoaderForTests } from "../src/drivers/claude-agent-sdk";
import { silentLogger } from "../src/core/logger";
import type { AgentInvocation } from "../src/drivers/types";

afterEach(() => __setSdkLoaderForTests(null));

let captured: { prompt: string; options: Record<string, unknown> } | undefined;

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

function invocation(over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    runId: "r",
    iteration: 0,
    workdir: mkdtempSync(path.join(tmpdir(), "loopgen-sdk-")),
    prompt: "do it",
    options: {},
    log: silentLogger,
    ...over,
  };
}

describe("claude-agent-sdk driver", () => {
  it("maps a successful result message to summary/usage/session/stopReason", async () => {
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
    const inv = invocation();
    const r = await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });

    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("completed");
    expect(r.summary).toBe("implemented it");
    expect(r.sessionId).toBe("sess-1");
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.02, turns: 4 });
  });

  it("classifies a max_turns result subtype", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "error_max_turns", result: "ran out" }]));
    const inv = invocation();
    const r = await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("max_turns");
  });

  it("classifies an error result subtype as a failure", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "error_during_execution", result: "boom" }]));
    const inv = invocation();
    const r = await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
  });

  it("treats a thrown query under an aborted signal as aborted", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([], { throwError: new Error("stream failed") }));
    const inv = invocation({ signal: AbortSignal.abort() });
    const r = await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("aborted");
  });

  it("fails clearly when the SDK is not installed", async () => {
    __setSdkLoaderForTests(async () => null);
    const inv = invocation();
    const r = await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/);

    const pf = await claudeAgentSdkDriver.preflight!({ workdir: inv.workdir, options: {} });
    expect(pf.ok).toBe(false);
  });

  it("preflight passes when the SDK loads", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([]));
    const pf = await claudeAgentSdkDriver.preflight!({ workdir: ".", options: { model: "claude-opus-4-8" } });
    expect(pf.ok).toBe(true);
  });

  it("maps spec options into the query() options", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    const inv = invocation({
      systemPrompt: "ROLE",
      resumeSessionId: "prev-sess",
      options: {
        model: "claude-x",
        maxTurns: 9,
        permissionMode: "acceptEdits",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        resume: true,
      },
    });
    await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });

    expect(captured!.prompt).toBe("do it");
    expect(captured!.options).toMatchObject({
      cwd: inv.workdir,
      model: "claude-x",
      maxTurns: 9,
      permissionMode: "acceptEdits",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      systemPrompt: "ROLE",
      resume: "prev-sess",
    });
    expect(captured!.options.abortController).toBeUndefined(); // no signal passed
  });

  it("does not forward resume when not requested", async () => {
    __setSdkLoaderForTests(async () => fakeSdk([{ type: "result", subtype: "success", result: "ok" }]));
    const inv = invocation({ resumeSessionId: "prev", options: {} });
    await claudeAgentSdkDriver.run(inv);
    rmSync(inv.workdir, { recursive: true, force: true });
    expect(captured!.options.resume).toBeUndefined();
    // defaults applied
    expect(captured!.options.permissionMode).toBe("bypassPermissions");
    expect(captured!.options.model).toBe("claude-opus-4-8");
  });
});
