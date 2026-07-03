# Authoring a loop you can trust

A `.loop.yaml` that parses isn't necessarily one worth running. This guide covers
how to author a spec that's **runnable and trustworthy** — one whose checks
actually test the requirement and start RED before the agent begins. (If you use
Claude Code, the `author-loop` skill runs these steps for you.)

`loopgen generate` already turns flags into a valid skeleton. What it can't supply
is the judgment: reading the actual target repo to pick the **right** checks,
writing concrete requirements, choosing the trust policy, and **proving** the spec
before any agent budget is spent.

## The one rule that matters most

**Every check must (a) test the requirement and (b) be RED before the agent
starts.** A loop is only as good as its evaluators — "all checks passed" means
nothing if the checks don't exercise the new behavior or were already green on
the untouched workspace. The last step below confirms exactly that.

## 1. Pin down the goal

Write the goal as something a command can verify. Push vague asks until they're
testable:

- "Make search better" is unusable.
- "Add case-insensitive substring matching to `searchUsers()` so `/users?q=AL`
  matches `alice`" is a loop.

You also need three more things:

- **Where the work happens** — the target repo, which becomes `workspace.dir`.
  Get an absolute path, or confirm the path relative to where the spec file will
  live.
- **What "done" looks like** — the signal that proves success: a failing test
  that should pass, a metric that should move, a build that should stay green.
- **Which driver** — `claude-agent-sdk` (default), `grok`, `github-copilot`, or
  `mock` (the offline demo). Real drivers need credentials.

If the goal is too vague to write a check for, resolve that **now**. A loop with
no real check is the most common way these waste hours.

## 2. Inspect the target repo — don't trust the defaults

This is the step generation can't do for you. Open the workspace and find ground
truth:

- **Language / package manager / framework** — from `package.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`.
- **The REAL commands.** The generic scaffold guesses (`npm test`,
  `npx tsc --noEmit`, `pytest -q`, and so on). Replace them with what the repo
  actually uses — read the `package.json` `scripts`, the `Makefile`, the CI
  config. A wrong test command is a guaranteed failed run.
- **The thing being changed** — find the file, function, or endpoint named in
  the goal so the requirements can reference real symbols and paths.
- **Is it a git repo?** Change detection and snapshots rely on git; a non-repo
  workspace trips the `SPEC-WORKDIR-NOT-PROJECT` lint rule.
- **State and side effects** — does the test command touch a database or a dev
  server? That decides `evaluation.concurrency` and whether a strict baseline is
  safe to run twice.

## 3. Decide the spec (with reasons)

Map what you found to fields. (The full schema and every knob live in
[the spec reference tables](#reference); the essentials:)

- **`task.type`** — `function` / `api` / `webapp` / `experiment` / `generic`.
  Picks the prompt framing and the checks the scaffold suggests.
- **`evaluators`** — the heart of the spec. Include at least one check that
  *fails until the requirement is met* (usually a test asserting the new
  behavior), and use the repo's real commands. For a numeric target, use the
  `experiment` evaluator. Avoid smoke tests that create their own data but never
  drive the real entrypoint — they can pass without exercising the feature.
- **`success`** — `all-pass` is the common case; use `score` / `pass` / `all` /
  `any` for thresholds or partial gates.
- **`limits.baseline`** — default to **`"strict"`** so an already-green
  (vacuous) check set fails fast with `baseline-vacuous`. Drop to `false` only
  when the checks side-effect and can't be run twice.
- **`limits.specGuard`** — keep the spec **outside** `workspace.dir` and leave
  it at `warn`. If it must live inside the repo the agent edits, set `error`.
- **`limits.evaluatorGuard`** — the test files a `command` check runs are the
  real success criteria; leave at `warn` (or `error`) so the agent can't fake a
  green by editing them.
- **`limits.maxIterations`** — a budget, not a target. 5–8 is typical; small,
  well-checked tasks need fewer.
- **`observability.observers`** — optional, but cheap insurance on a real run:
  a `jsonl` observer (or `--trace` at run time) captures the agent's inner
  trajectory, which is the evidence [debugging](./debugging-loops.md) wants
  when a run stalls. See [Observing runs](./observing-runs.md).

## 4. Generate the skeleton, then edit

Generate a guaranteed-valid skeleton, then fix the fields the defaults got
wrong. Editing a generated file beats hand-writing YAML — the skeleton always
parses, so you only change values.

```bash
loopgen generate \
  -n "add-retry-to-fetchUser" \
  -t function -l typescript -f express \
  -d claude-agent-sdk \
  -r "Add exponential backoff (max 3 retries) to fetchUser(); keep the signature." \
  -m 6 -o ./loops/add-retry.loop.yaml
```

(From this repo without a build, prefix with `npm run loopgen --`, e.g.
`npm run loopgen -- generate …`.)

Then edit the file to: swap in the **real** test/build commands, set
`workspace.dir` to the target repo, set `limits.baseline: strict`, tighten
`requirements`, and adjust `success` if needed. Keep the spec **outside** the
target repo and point `workspace.dir` at it.

## 5. Prove it — the part that earns trust

Two gates, neither of which spends agent budget.

**a. Lint clean.**

```bash
loopgen lint ./loops/add-retry.loop.yaml --strict
```

Resolve every `✗` error and `⚠` warning. Don't hand off a spec with open
errors. Each rule and its fix is documented in
[the lint reference](./lint-and-trust.md#linting-before-you-run).

**b. The checks start RED for the right reason.** There is no agent-free
"baseline only" run mode, so verify directly: run each evaluator's command
yourself in the target workspace and confirm it **fails because the requirement
isn't met yet** — not because a binary is missing, the working directory is
wrong, or the command is bogus.

```bash
# in the target repo, on an untouched checkout:
npm test              # should FAIL (the new behavior isn't implemented yet)
npx tsc --noEmit      # should pass or fail per the real baseline
```

If a check passes on the untouched workspace, it doesn't test the requirement —
fix the check before continuing. This is the same contract
`limits.baseline: strict` enforces at runtime; you're confirming it up front so
a run doesn't waste budget discovering it.

## 6. Run it

Once lint is clean and the checks start RED, you're ready:

```bash
loopgen run ./loops/add-retry.loop.yaml --strict-baseline --report run.json
```

A real run spends agent budget and needs the driver's credentials
(`ANTHROPIC_API_KEY` for `claude-agent-sdk`, `XAI_API_KEY` for `grok`, and so
on). The `--report run.json` file is the richest input to the
[debugging workflow](./debugging-loops.md) if the run doesn't go green.

## Guardrails

- **Don't fabricate the test command.** Read it from the repo. If there isn't
  one, say so and consider adding a test as part of the loop.
- **Don't ship a vacuous loop.** If you can't make a check that's RED before the
  work, the loop isn't ready — that's a signal the task may be a
  [poor fit](../README.md#when-to-use-it-and-when-not), not a spec to force
  through.
- **Keep the spec out of the target repo** unless you have a reason not to; if
  it lives inside, set `specGuard: error`.
- **Re-lint after every edit.** It takes milliseconds and catches compounded
  relative paths and missing binaries before a run does.

## Reference

For exact field names, defaults, the per-language default commands, evaluator
options, success-criteria forms, and the full lint-rule → fix table, see the
in-repo `author-loop` skill's `reference.md`
(`.claude/skills/author-loop/reference.md`) and
[the spec section of the README](../README.md#the-spec). The source of truth is
the code: `src/core/spec.ts` (schema), `src/tasks/` (task types and default
commands), and `src/lint/rules.ts` (lint rules).
