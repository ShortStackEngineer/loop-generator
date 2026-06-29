# add-driver reference

The `AgentDriver` contract, the four conformance scenarios (the success gate),
the backend shapes, and copy-paste skeletons. Workflow is in `SKILL.md`.

Source of truth: `src/drivers/types.ts` (contract), `src/testing/conformance.ts`
(scenarios), `src/registry.ts` (registration), `src/core/preflight.ts` (helpers),
and the three reference drivers `src/drivers/{mock,grok,claude-agent-sdk}.ts`.
Code wins over this doc.

## The contract — `AgentDriver`

```ts
interface AgentDriver {
  readonly name: string;                 // stable id referenced by driver.uses; must be non-empty
  readonly description?: string;
  preflight?(ctx: { workdir: string; options: Record<string, unknown> }): Promise<PreflightResult>;
  run(invocation: AgentInvocation): Promise<AgentRunResult>;
}
```

### What `run` receives — `AgentInvocation`

| Field | Use |
|-------|-----|
| `workdir` | **Absolute path the agent must confine all edits to.** Resolve every file path against this. |
| `prompt` | The concrete instruction for this iteration. |
| `systemPrompt?` | Role framing. Real-agent drivers fold it in front of `prompt` (see grok) or pass it through (SDK). |
| `feedback?` | `{ passed, reason, text, evaluations }` from the previous iteration; `undefined` on iter 0. Fold `feedback.text` into the prompt. |
| `iteration` | 0-based. Scripted drivers index their steps by this. |
| `resumeSessionId?` | Prior session to continue (after a `max_turns` stop), if your backend + options support resume. |
| `options` | The spec's `driver.options` (untyped). Parse with a zod schema. |
| `signal?` | Aborts on timeout/cancel. **Honor it** (see honors-abort). |
| `log` | Scoped logger; `log.child("…")`. |
| `runId` | Stable id for the whole run. |

### What `run` returns — `AgentRunResult`

| Field | Meaning |
|-------|---------|
| `ok` | `false` means **the driver/backend failed** — not that the code is wrong. A failing *check* is still `ok: true`. |
| `stopReason?` | `completed` \| `max_turns` \| `aborted` \| `error` \| `unknown`. Drives the engine's honesty warnings. |
| `summary?` | Short text of what the agent reported doing. |
| `changedFiles?` | Files changed, if known. Used for no-op detection only when git change-detection is unavailable. |
| `usage?` | `{ inputTokens?, outputTokens?, costUsd?, turns? }`. |
| `sessionId?` | Opaque handle to resume next iteration. |
| `raw?` | Transcript/raw output for the JSON report. Tail it; don't dump megabytes. |
| `error?` | Set when `ok: false`. |

**stopReason semantics that matter:**
- `max_turns` → return **`ok: true`** with `stopReason: "max_turns"`. The agent did real work but didn't self-terminate; the engine reports it as incomplete and can resume. Do **not** treat it as a crash.
- `error` → `ok: false`. A real backend failure (auth, network, crash).
- `aborted` → on an aborted signal, return `ok: false, stopReason: "aborted"` (or throw).

## The success gate — four conformance scenarios

`runDriverConformance` runs each against a fresh temp workspace. All must pass
(`honors-abort` can warn-but-pass). Target file is `OUTPUT.txt` at workspace root.

| Scenario | What it does | Your driver must | Common failure → fix |
|----------|--------------|------------------|----------------------|
| `reports-name` | reads `driver.name` | expose a non-empty string `name` | empty name → set it |
| `creates-file` | prompt: *"Create a file named OUTPUT.txt … whose entire contents are exactly: `<token>`"* | create `OUTPUT.txt` in `workdir` with exactly `<token>` (trimmed compare) | file missing → you didn't write to `workdir`; contents mismatch → trailing text/markdown fences around the token |
| `applies-feedback` *(2 iters)* | iter0 prompt → write `WRONG`; iter1 prompt: *"Update OUTPUT.txt so its entire contents are exactly: `<token>`"* + `feedback.text` | on iter1, overwrite the file to the new token | stuck on WRONG → you ignore the iter1 prompt/`feedback`; for scripted drivers, your `optionsFor` must return a 2nd step |
| `honors-abort` | calls `run` with an already-aborted signal | throw **or** return `ok: false` | ignoring it still *passes* but is flagged `⚠`; check `signal.aborted` early and on subprocess/fetch |

The harness extracts the token from the **prompt** for prompt-driven drivers. So
a real-agent driver passes naturally *if the agent actually edits files*. A pure
model-server driver must parse the token out itself and write the file.

## Three backend shapes (decides how much you write)

1. **Thin / agentic CLI** (like `grok`): the backend is already a coding agent
   with filesystem + tools. Driver = spawn subprocess in `workdir`, pass the
   prompt, parse output for summary/usage/sessionId. Conformance passes because
   the agent does the edits. Template: `src/drivers/grok.ts`.
2. **Thin / agentic SDK** (like `claude-agent-sdk`): same, but a streaming
   async-iterable library. Dynamic-import it (optional dep), consume messages,
   detect completion via a `result` message. Template:
   `src/drivers/claude-agent-sdk.ts`.
3. **Model server** (LM Studio, Ollama, raw OpenAI-compatible endpoint): pure
   inference, **no filesystem or tools**. The *driver* must supply the agent
   scaffolding — ask the model for file contents, parse, and write them itself;
   fold `feedback.text` into the next prompt. More code, but conformance is cheap
   and deterministic (no agentic tool loop needed for the harness's file tasks).
   Skeleton below.

## How `verify-driver` treats your driver (cost!)

`loopgen verify-driver <name>` runs prompt-driven by default; `--scripted` (or
name `mock`) supplies mock-style step options via `scriptedMockOptionsFor`
(expects an option shape of `{ steps: [{ files: {...} }] }`).

- **Scripted / model-server with a local endpoint** → verification is offline
  and free.
- **Real hosted agent (SDK/grok)** → the harness **actually invokes the agent**
  (creates files, two iterations, abort) → it **spends tokens/credentials and
  needs the backend installed**. Develop the structure offline first (unit test
  with a fake loader / local endpoint), then run `verify-driver` once for real.

## Registration

Add two lines to `src/registry.ts` → `createDriverRegistry()`:

```ts
import { myDriver } from "./drivers/my-driver";
// …
r.register(myDriver);
```

Then `npm run loopgen -- list drivers` shows it and
`npm run loopgen -- verify-driver my-driver` runs the gate.

## Building blocks

- `preflightOk(notes?, warnings?)` / `preflightFail(errors, warnings?)` from
  `../core/preflight` — return these from `preflight`.
- `runCommand(cmd, { cwd, signal })` from `../core/exec` — run a shell command.
- `z` (zod **v4**) for the options schema: `optionsSchema.parse(invocation.options)`.
  Note v4 API: `z.record(z.string(), z.string())` (two args).
- Optional npm deps: keep in `optionalDependencies`, mark `external` in
  `tsup.config.ts`, and **dynamic-import** behind try/catch so core works without
  them (see `importSdk`).
- **Test seam** for externally-authenticated backends: expose an injectable
  loader (`__setSdkLoaderForTests`) or honor a binary override env var
  (`GROK_BIN`) so unit tests never hit the network.

## Skeleton A — thin agentic CLI (subprocess)

Trim `src/drivers/grok.ts`; the spine:

```ts
import { spawn } from "node:child_process";
import { z } from "zod";
import { preflightOk, preflightFail } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult } from "./types";

const optionsSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  resume: z.boolean().default(false),
});

export const myCliDriver: AgentDriver = {
  name: "my-cli",
  description: "Invoke <agent> via its CLI (headless).",
  async preflight({ options }) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) return preflightFail([parsed.error.issues.map(i => i.message).join("; ")]);
    // probe the binary is installed; warn (not fail) on missing credentials
    return preflightOk(["my-cli ready"]);
  },
  async run(inv: AgentInvocation): Promise<AgentRunResult> {
    if (inv.signal?.aborted) return { ok: false, stopReason: "aborted", error: "aborted" };
    const opts = optionsSchema.parse(inv.options);
    const prompt = inv.systemPrompt ? `${inv.systemPrompt}\n\n${inv.prompt}` : inv.prompt;
    // spawn the CLI in inv.workdir with a non-interactive/headless flag + json output;
    // wire inv.signal to child.kill; parse stdout for final text / usage / sessionId;
    // classify: max_turns → { ok:true, stopReason:"max_turns" }; non-zero exit → { ok:false, stopReason:"error" }.
    return { ok: true, stopReason: "completed", summary: "…" };
  },
};
```

## Skeleton B — model server (OpenAI-compatible, no tools)

The driver writes files itself. Honors abort via the fetch signal.

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { preflightOk, preflightFail } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult } from "./types";

const optionsSchema = z.object({
  baseUrl: z.string().default("http://localhost:1234/v1"),
  model: z.string().default("local-model"),
  apiKey: z.string().optional(),
});

export const myModelDriver: AgentDriver = {
  name: "my-model",
  description: "Drive a local OpenAI-compatible model server (no agent tools).",
  async preflight({ options }) {
    const o = optionsSchema.parse(options);
    try {
      const res = await fetch(`${o.baseUrl}/models`);
      if (!res.ok) return preflightFail([`model server at ${o.baseUrl} returned ${res.status}`]);
      return preflightOk([`server: ${o.baseUrl}`, `model: ${o.model}`]);
    } catch (e) {
      return preflightFail([`no model server at ${o.baseUrl}: ${(e as Error).message}`]);
    }
  },
  async run(inv: AgentInvocation): Promise<AgentRunResult> {
    if (inv.signal?.aborted) return { ok: false, stopReason: "aborted", error: "aborted" };
    const o = optionsSchema.parse(inv.options);
    // Ask for a strict JSON object of { "relpath": "contents" }. Fold feedback in.
    const instruction = [
      inv.systemPrompt ?? "",
      inv.prompt,
      inv.feedback ? `\nPrevious feedback:\n${inv.feedback.text}` : "",
      `\nReply with ONLY a JSON object mapping each file path (relative to the workspace) to its full new contents.`,
    ].join("\n");
    let res: Response;
    try {
      res = await fetch(`${o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify({ model: o.model, messages: [{ role: "user", content: instruction }], temperature: 0 }),
        signal: inv.signal,
      });
    } catch (e) {
      const aborted = inv.signal?.aborted || /abort/i.test((e as Error).message);
      return { ok: false, stopReason: aborted ? "aborted" : "error", error: (e as Error).message };
    }
    if (!res.ok) return { ok: false, stopReason: "error", error: `server ${res.status}` };
    const json = await res.json() as any;
    const content: string = json.choices?.[0]?.message?.content ?? "";
    const usage = { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens };
    // Parse the JSON object of files (strip ``` fences first), then write each file under inv.workdir.
    let files: Record<string, string>;
    try {
      files = JSON.parse(content.replace(/^```(json)?|```$/g, "").trim());
    } catch {
      return { ok: false, stopReason: "error", error: "model did not return parseable file JSON", raw: content };
    }
    const changedFiles: string[] = [];
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.resolve(inv.workdir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      changedFiles.push(rel);
    }
    return { ok: true, stopReason: "completed", summary: `wrote ${changedFiles.length} file(s)`, changedFiles, usage };
  },
};
```

> The model-server skeleton parses the token straight from the prompt-driven
> conformance prompts and writes `OUTPUT.txt`, so it satisfies `creates-file` and
> `applies-feedback` without any agentic tool loop. Real tasks need richer
> scaffolding (multi-file context, reads), but this is enough to pass the gate and
> ship an MVP.
