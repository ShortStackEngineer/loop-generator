---
name: author-loop
description: >-
  Author a verified loop-generator spec (.loop.yaml) by interviewing the
  developer about the goal, inspecting the target repo for the real
  test/build/typecheck commands, then proving the spec is sound (lint-clean and
  checks start RED) before handing it off. Use when someone wants to create,
  scaffold, or set up a new agent coding feedback loop, write a .loop.yaml, or
  turn a task into a runnable loopgen spec.
---

# author-loop

Produce a `.loop.yaml` that is *runnable and trustworthy* — not just well-formed.

`loopgen generate` already turns flags into a valid skeleton. The value this
skill adds is the judgment a flag can't: reading the actual target repo to pick
the **right** checks, writing concrete `requirements` prose, choosing the trust
policy, and then **proving** the spec before any agent budget is spent. A loop is
only as good as its evaluators: "all checks passed" means nothing if the checks
don't exercise the new requirement or were already green.

Field names, defaults, task-type scaffolds, evaluator options, and the lint-rule
→ fix table live in `reference.md` (read it when you need exact details). The CLI
is invoked as `npm run loopgen -- <args>` from the repo root (no build needed),
or `loopgen <args>` after `npm run build`.

## The one rule that makes this worth doing

**Every check must (a) test the requirement and (b) be RED before the agent
starts.** A check that's green on an untouched workspace verifies nothing. The
final step of this skill confirms exactly that.

## Workflow

### 1. Interview — only for what can't be inferred

Ask the developer for the essentials, but keep it short: infer everything you can
from the repo in step 2 and *confirm* rather than interrogate. You need:

- **The goal** → becomes `requirements`. Push for something testable. "Make
  search better" is unusable; "add case-insensitive substring matching to
  `searchUsers()` so `/users?q=AL` matches `alice`" is a loop.
- **Where the work happens** → the target repo / `workspace.dir`. Get an absolute
  path or confirm it relative to where the spec will live.
- **What "done" looks like** → which signals prove success (a failing test that
  should pass, a metric that should move, a build that should stay green).
- **Which driver** → `claude-agent-sdk` (default), `grok`, or `mock` (offline
  demo). Real drivers need credentials (`ANTHROPIC_API_KEY` / `XAI_API_KEY`).

If the goal is too vague to write a check for, resolve that *now* — a loop with
no real check is the most common way these waste hours.

### 2. Inspect the target repo — don't trust the defaults

This is the step `generate` can't do. Open the workspace and find ground truth:

- **Language / package manager / framework** — `package.json`, `pyproject.toml`,
  `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`.
- **The REAL commands.** The generic scaffold guesses `npm test` /
  `npx tsc --noEmit` etc. (see the per-language table in `reference.md`). Replace
  them with what the repo actually uses — read `package.json` `scripts`, the
  `Makefile`, CI config. A wrong test command is a guaranteed failed run.
- **The thing being changed** — find the file/function/endpoint named in the
  goal so `requirements` can reference real symbols and paths.
- **Is it a git repo?** Change-detection and snapshots rely on git; a non-repo
  workspace trips `SPEC-WORKDIR-NOT-PROJECT`.
- **State/side effects** — does the test command touch a DB or dev server? That
  decides `evaluation.concurrency` and whether `baseline: strict` is safe.

### 3. Decide the spec (with reasons)

Map the findings to fields (full schema in `reference.md`):

- **`task.type`** — `function` / `api` / `webapp` / `experiment` / `generic`.
  Picks the prompt framing and the scaffolded checks.
- **`evaluators`** — the heart of the spec. Include a check that *fails until the
  requirement is met* (commonly a test that asserts the new behavior). Use the
  repo's real commands. For metrics/perf use the `experiment` evaluator. Avoid
  smokes that create their own data without driving the real entrypoint
  (`SPEC-SMOKE-SELF-FULFILLING`).
- **`success`** — `all-pass` is the common case; use `score`/`pass`/`all`/`any`
  for thresholds or partial gates.
- **`limits.baseline`** — default to **`"strict"`** so a vacuous (already-green)
  check set fails fast. Drop to `false` only when checks side-effect and can't
  run twice.
- **`limits.specGuard`** — keep the spec **outside** `workspace.dir` and leave
  `warn`. If it must live inside, set `error`.
- **`limits.maxIterations`** — a budget, not a target. 5–8 is typical; small,
  well-checked tasks need fewer.

### 4. Generate the skeleton, then edit

Generate a guaranteed-valid skeleton, then fix the fields the defaults got wrong.
Place the spec **outside** the target repo and point `workspace.dir` at it.

```bash
npm run loopgen -- generate \
  -n "add-retry-to-fetchUser" \
  -t function -l typescript -f express \
  -d claude-agent-sdk \
  -r "Add exponential backoff (max 3 retries) to fetchUser(); keep the signature." \
  -m 6 -o ./loops/add-retry.loop.yaml
```

Then edit the file to: swap in the **real** test/build commands, set
`workspace.dir` to the target, set `limits.baseline: strict`, tighten
`requirements`, and adjust `success` if needed. (Editing a generated file beats
hand-writing YAML — the skeleton is schema-valid; you only change values.)

### 5. Prove it — the part that earns trust

Two gates, neither of which spends agent budget:

**a. Lint clean.**
```bash
npm run loopgen -- lint ./loops/add-retry.loop.yaml --strict
```
Resolve every `✗` error and `⚠` warning (see the rule→fix table in
`reference.md`). Don't hand off a spec with open errors.

**b. Checks start RED for the right reason.** There is no agent-free "baseline
only" run mode, so verify directly: run each evaluator's command yourself in the
target workspace and confirm it **fails because the requirement isn't met yet** —
not because a binary is missing, the cwd is wrong, or the command is bogus.

```bash
# in the target repo:
npm test              # should FAIL (the new behavior isn't implemented)
npx tsc --noEmit      # should pass or fail per the real baseline
```

If a check passes on the untouched workspace, it doesn't test the requirement —
fix the check before continuing. This is the same contract `baseline: strict`
enforces at runtime; you're confirming it up front.

### 6. Hand off

Summarize tightly:
- the decisions and *why* (task type, the key check, baseline/guard policy);
- confirmation that lint is clean and the checks start RED;
- the exact command to run it, and a note that a real run needs credentials:

```bash
npm run loopgen -- run ./loops/add-retry.loop.yaml --strict-baseline --report run.json
```

Offer to kick off the run, but don't start it unprompted — it spends real agent
budget and needs the driver's credentials.

## Guardrails

- **Don't fabricate the test command.** Read it from the repo. If you can't find
  one, say so and propose adding a test as part of the loop.
- **Don't ship a vacuous loop.** If you can't make a check that's RED before the
  work, the loop isn't ready — surface that instead of generating anyway.
- **Keep the spec out of the target repo** unless the developer insists; if it's
  inside, set `specGuard: error`.
- **Prefer editing the generated skeleton** over hand-writing YAML, so the result
  always parses.
- **Re-lint after every edit.** It's milliseconds; it catches compounded relative
  paths and missing binaries before a run does.
