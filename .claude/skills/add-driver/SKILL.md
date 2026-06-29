---
name: add-driver
description: >-
  Scaffold a new loop-generator agent backend (an AgentDriver) and drive it to
  green against the conformance harness — implement name/preflight/run, register
  it, then loop on `loopgen verify-driver <name>` fixing one failing scenario at a
  time until all four pass. Use when someone wants to add or integrate a new agent
  or model backend (e.g. LM Studio, Ollama, Codex, Aider, Cursor, a custom CLI or
  OpenAI-compatible endpoint), write a custom AgentDriver, or when `verify-driver`
  / driver conformance is failing.
---

# add-driver

Add a new agent backend by implementing the `AgentDriver` contract, then proving
it with the conformance harness the project ships for exactly this purpose. The
work itself is a feedback loop — the same shape loop-generator automates:

> **scaffold → `verify-driver` → read the failing scenario → fix → repeat until PASS.**

Treat `loopgen verify-driver <name>` as the success criteria and grind on it.

The contract, the four scenarios, backend shapes, building blocks, and two
copy-paste skeletons live in `reference.md`. CLI is `npm run loopgen -- <args>`.

## Step 1 — classify the backend (this decides the effort)

Before writing anything, determine which of three shapes the backend is (full
descriptions in `reference.md` → "Three backend shapes"):

- **Agentic CLI** (e.g. grok) — already edits files and runs tools. Driver just
  spawns it. Template: `src/drivers/grok.ts`. **Skeleton A.**
- **Agentic SDK** (e.g. claude-agent-sdk) — streaming library that edits files.
  Dynamic-import it as an optional dep. Template: `src/drivers/claude-agent-sdk.ts`.
- **Model server** (e.g. LM Studio / Ollama / OpenAI-compatible) — pure
  inference, **no filesystem or tools**. The *driver* must write files itself.
  More code. **Skeleton B.**

If it isn't obvious from the request, ask: *does this backend edit files on its
own, or does it only return text?* That answer is the whole design.

## Step 2 — scaffold `src/drivers/<name>.ts`

Copy the closest template/skeleton from `reference.md` and fill in:

- **`name`** — the stable id used in `driver.uses`. Non-empty (or `reports-name`
  fails immediately).
- **options schema** — a zod (**v4**) schema; `optionsSchema.parse(inv.options)`.
- **`preflight`** — validate options, check the backend is reachable/installed,
  return `preflightFail([...])` for hard blockers and `preflightOk(notes, warnings)`
  otherwise. Missing *credentials* are usually a warning, not a failure.
- **`run`** — the core. Get these right or conformance fails:
  - **Confine all edits to `inv.workdir`** — resolve every path against it.
  - **Honor `inv.signal`** — return `{ ok: false, stopReason: "aborted" }` (or
    throw) when aborted; wire it to your subprocess `kill` / `fetch` signal.
  - **Apply feedback** — fold `inv.feedback?.text` into the iter-1 prompt so the
    `applies-feedback` scenario can correct the file.
  - **Classify the stop honestly** — `max_turns` ⇒ `ok: true` +
    `stopReason: "max_turns"` (incomplete, not a crash); real failures ⇒
    `ok: false` + `stopReason: "error"`. (See `reference.md` for why.)
  - For optional npm deps, dynamic-import behind try/catch and add a **test seam**
    (injectable loader or a binary-override env var) so CI never hits the network.

## Step 3 — register it

Add the import + `r.register(<driver>)` to `createDriverRegistry()` in
`src/registry.ts`. Confirm it's visible:

```bash
npm run loopgen -- list drivers      # your driver should appear
```

## Step 4 — the conformance loop (the heart of this skill)

Run the gate and fix one scenario at a time:

```bash
npm run loopgen -- verify-driver <name>                 # prompt-driven (real agents)
npm run loopgen -- verify-driver <name> --scripted      # mock-style step options
```

Read the report — each line is `✓`/`⚠`/`✗ <scenario> — <detail>`. Map the first
`✗` to a fix via `reference.md` ("four conformance scenarios" table), edit, re-run.
Repeat until `PASS`. The usual offenders:

- `creates-file` fails *"not created"* → you didn't write under `inv.workdir`.
- `creates-file` fails *"contents mismatch"* → you wrapped the token (e.g. ```` ``` ````
  fences, extra prose). Emit the file body only.
- `applies-feedback` stuck on `WRONG` → you ignore the iter-1 prompt/`feedback`
  (or a scripted `optionsFor` returns no 2nd step).
- `honors-abort` shows `⚠` → it passes but you're ignoring the signal; honor it.

**Cost caveat (read before re-running real agents):** verifying a *real hosted
agent* makes the harness **actually invoke it** (two iterations + file creation)
— that spends tokens/credentials and needs the backend installed. Develop the
structure offline first (Step 5's unit test, or a local model-server endpoint),
then run `verify-driver` for real once it should pass. A scripted or
local-endpoint driver verifies free.

## Step 5 — lock it in

Conformance is the behavioral gate; add a fast unit test so it can't regress:

- Use the test seam to avoid the network (fake SDK loader, `GROK_BIN`-style
  override, or point the model driver at a stub). See
  `test/mock-conformance.test.ts` for the pattern (it builds tiny in-test drivers
  and asserts `runDriverConformance(...).passed`).
- `npm run typecheck && npm test` green.

## Step 6 — hand off

Document, briefly: the `driver.options` your driver accepts (with defaults), the
credentials/install it needs, and a one-line spec snippet (`driver: { uses:
<name>, options: {...} }`). Note whether `verify-driver <name>` is free (scripted
/ local) or costs budget (hosted agent).

## Guardrails

- **Conformance is non-negotiable.** Don't register a driver you haven't driven
  to `PASS` (or that only passes with unexplained `--skip`).
- **`ok: false` means the *driver* failed, not the code.** A failing check is a
  normal `ok: true` result — don't conflate them, or the engine's reporting lies.
- **Never let edits escape `inv.workdir`.** It's the safety boundary the whole
  engine relies on.
- **Keep core importable without the backend.** Optional deps stay optional
  (dynamic import + `optionalDependencies` + tsup `external`).
- **Don't burn budget to debug structure.** Get it green offline first; spend a
  real `verify-driver` run only to confirm.
