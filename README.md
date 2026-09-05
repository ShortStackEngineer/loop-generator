# loop-generator

**Write the definition of done. Any agent does the work. You get the receipt.**

loop-generator is a definition-of-done engine for coding agents. You write the
checks — tests, type checks, a metric with a threshold — that are RED today and
go GREEN only when the work is really finished. Claude, Grok, Copilot, or a
local model works until they pass. And the run ends in a report you can hand
to a reviewer, not the agent's word that it's done.

```
$ npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml

[loopgen:iter0] starting iteration 1/5
  iter 1: retry — agent ok — ✗ answer-check · 1 file(s)
[loopgen:iter0] result: not yet — failing: answer-check
[loopgen:iter1] starting iteration 2/5
  iter 2: PASS — agent ok — ✓ answer-check · 1 file(s)
[loopgen:iter1] result: PASS — all checks passed

✓ SUCCESS — mock-demo
outcome: success — all checks passed
iterations: 2, time: 0.0s
changed: 1 file(s)
```

That's the offline demo — no API key, a scripted `mock` agent — and it is the
whole product in miniature: a check fails, the agent gets the failure back,
the check passes, and the run ends in an outcome you didn't have to take on
faith.

**Docs:** the full detail lives at
**<https://shortstackengineer.github.io/loop-generator/>** — this README is the
short version.

## How it works

```
.loop.yaml ─► drive agent ─► audit work ─► run checks ─► fold feedback ─► LoopReport
 task+checks    any backend   diff+guards   the gate      + last diff      the verdict
```

**You write what done means.** A `.loop.yaml` is the contract: the task, the
workspace the agent may edit, and the checks that must go from RED to GREEN. If
you can't write a check that's red today and green only when the requirement is
met, the work isn't ready for an agent yet — and `loopgen lint` plus
`--verify` tell you that before a token is spent.

**Any agent grinds toward it.** The agent is a plug-in, held to the same
contract whichever one you pick: `claude-agent-sdk`, `grok`, `github-copilot`,
`opencode` (including local models), or the scripted `mock`. Each round it sees
which checks still fail and what it changed last time, and tries again until
the checks pass or the budget runs out.

**You get the report.** A run ends in a `LoopReport`, not a claim. It shows
what the agent changed, which checks it passed, what it cost, and whether
anything it wasn't allowed to touch was touched. If the green wasn't earned, the
report says so in one word — `baseline-vacuous`, `spec-tampered`,
`evaluator-tampered`, `budget-exceeded` — and says why.

## Why the green is earned

Reward hacking isn't hypothetical: [frontier coding models have been caught
special-casing tests, hard-coding expected values, and editing the very test
files that grade them](https://www.anthropic.com/research/emergent-misalignment-reward-hacking).
Most loop runners take the agent's word for it. This one treats every green as
a claim to be checked, and the report tells you what it checked.

| What the report certifies | How | If it fails |
|---------------------------|-----|-------------|
| The tests the checks run were not edited | Evaluator-integrity guard (hash-watched) | `evaluator-tampered` |
| The success criteria were not rewritten | Spec-integrity guard (hash-watched) | `spec-tampered` |
| The checks were RED before the work began | Baseline evaluation (`baseline: strict`) | `baseline-vacuous` |
| Real files changed, not just build output | Workspace change detection (git-index diff) | vacuous-success warning |
| Spend stayed under the ceiling | Cost / token ceilings | `budget-exceeded` |
| The agent actually finished its last turn | Honest `stopReason` reporting | warning on a green run |

"Done" is a rule over *your* check results, never the model's opinion. How each
guard works — and where each has honest limits — is in the
[trust model](https://shortstackengineer.github.io/loop-generator/docs/trust.html).

## Install

```bash
npm install
# The Claude Agent SDK, Grok Build CLI, GitHub Copilot CLI, and opencode are optional backends.
# For real agent runs, set credentials for the driver you use:
export ANTHROPIC_API_KEY=...   # for claude-agent-sdk (or Claude login / Bedrock / Vertex)
export XAI_API_KEY=...         # for the grok driver (or run `grok` interactive login)
# github-copilot: install the `copilot` CLI and run it once to authenticate
# opencode: install the `opencode` CLI; runs against local models, no key needed
```

### Local models (LM Studio / Ollama)

LM Studio and Ollama are inference servers, not coding agents. Use the
existing `opencode` driver and point `driver.options.model` at a
**tool-calling** local model in `provider/model` form:

```yaml
driver:
  uses: opencode
  options:
    model: lmstudio/qwen/qwen3-coder-next   # prefix required
    dangerouslySkipPermissions: true
```

Confirm ids with `curl http://127.0.0.1:1234/v1/models` and `opencode models`,
then run `examples/building-blocks/opencode-feature.loop.yaml` (after
`loopgen init-target opencode-feature`). A missing prefix or a stopped LM
Studio shows up as a preflight warning. loop-generator will not grow an
in-tree HTTP coding agent — if you need to own the tool loop, that is a
separate project.

## Quick start

Run the offline demo (no API key needed; it uses the scripted `mock` driver):

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
```

Write a loop of your own and run it:

```bash
npm run loopgen -- generate -i --verify   # interactive; proves it's lint-clean + starts RED
npm run loopgen -- run my-loop.loop.yaml
npm run loopgen -- run my-loop.loop.yaml --trace trace.jsonl   # + a full execution trace
```

`--verify` encodes the authoring contract: after writing the spec it lints it
and runs the checks once with no agent turns, confirming they start **RED** — a
green check before any work probably doesn't test the requirement.

(After `npm run build && npm link` — or a global install — use the `loopgen`
binary directly instead of `npm run loopgen -- <args>`.)

## The spec

```yaml
version: 1
name: add-retry-to-fetchUser
task: { type: function }
stack: { language: typescript, packageManager: npm }
workspace:
  dir: ./target          # the directory the agent edits (relative to this file)
requirements: |
  Add exponential backoff (max 3 retries) to fetchUser(). Keep the signature.
driver:
  uses: claude-agent-sdk
  options: { model: claude-opus-4-8, maxTurns: 30 }
evaluators:
  - uses: command
    as: tests
    options: { command: npm test }
  - uses: command
    as: typecheck
    options: { command: npx tsc --noEmit }
success:
  type: all-pass         # all evaluators must pass
limits:
  maxIterations: 6
  baseline: strict       # fail if the checks were already green before any work
  specGuard: error       # fail if the agent edits this spec
  evaluatorGuard: error  # fail if the agent edits a check's test files
  maxCostUsd: 5.0        # stop (budget-exceeded) past this cumulative spend
```

The three guards are shown in the recommended "audit" posture; today's schema
defaults are looser (`baseline: false`, both guards `warn`), so set them
explicitly — hardening the defaults is on the
[roadmap](https://shortstackengineer.github.io/loop-generator/docs/roadmap.html).
Every field, evaluator option, and success rule is documented in
[the spec reference](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#spec).

## From one loop to a whole app

One loop delivers one checkable outcome. An application is a graph of them, and
the same discipline scales: cut the app into the smallest slices a check can
observe ("a coach can sign in", "a client cannot see coach-only pages"), order
them by what each needs built first, give every slice its own RED checks, and
run the graph as a `.batch.yaml` — the scheduler respects `needs`, caps
concurrency, and never lets two loops edit the same workspace at once.

The repo ships the tooling for that as Claude Code skills in
[`.claude/skills/`](./.claude/skills) — they load automatically when you open
the repo in Claude Code:

- **`frame-app`** — decompose an app spec into a dependency-ordered graph of
  RED-able slices and emit the buildable frontier.
- **`frame-checks`** — turn one request into falsifiable acceptance checks:
  RED now, for the right reason, hard to fake.
- **`author-loop`** — interview the goal, inspect the repo for the real
  commands, and hand back a spec that lints clean and starts RED.
- **`debug-loop`** — diagnose a failed, stalled, or suspiciously-green run by
  its `outcome` without spending agent budget.
- **`add-driver`** — scaffold a new agent backend and drive it through the
  conformance harness.

It has been run end to end: [`test-runs/leadership-coaching-portal-v2`](./test-runs/leadership-coaching-portal-v2)
builds a ten-slice coaching portal from a plan, per-slice checks, and a batch
manifest — 10/10 trustworthy greens under `baseline: strict` with the
evaluator guard armed, for about $1.77 and nine minutes of agent time. The
run's README also records what the experiment *didn't* show, which is how a
case study should read. The in-repo [`loops/`](./loops) library applies the
same workflow to changes to loop-generator itself.

## When to use it

Use it where success is mechanically checkable and the run is unattended:
a failing test to make green (while keeping the rest green), a measurable
target (p95 under X ms, coverage ≥ 90%), or a concrete check applied across
many call sites. If you can't write a check that's RED before the work and
turns GREEN only when the requirement is met, the task isn't ready for a loop —
"improve the architecture" and other judgment-heavy work will only tell you the
checks were the wrong contract. The guards make bad checks, gamed metrics, and
agent drift *visible*; they don't eliminate them. The full fit guide is in
[when a loop fits](https://shortstackengineer.github.io/loop-generator/docs/authoring.html#fit).

## Going deeper

- **[Trust model](https://shortstackengineer.github.io/loop-generator/docs/trust.html)** —
  how each guard works (change detection, baseline, tamper guards, budget
  ceilings) and where each has honest limits.
- **[Lint before you run](https://shortstackengineer.github.io/loop-generator/docs/trust.html#lint)** —
  `loopgen lint` catches a misconfigured spec in milliseconds, before any agent
  turn: wrong workspace, missing binaries, destructive checks, racy parallelism.
- **[Observing a run](https://shortstackengineer.github.io/loop-generator/docs/observing.html)** —
  the checks tell you *what* failed; the trace tells you *why the agent didn't
  fix it*. `--trace file.jsonl` for JSONL, or declare `jsonl` / `otlp` observers
  in the spec (standard OTLP spans, zero OTel dependency).
- **[Authoring](https://shortstackengineer.github.io/loop-generator/docs/authoring.html)
  and [debugging](https://shortstackengineer.github.io/loop-generator/docs/debugging.html) workflows** —
  interview the goal into something checkable and prove the spec RED before
  spending budget; diagnose a failed or suspiciously-green run by its `outcome`.
- **[Batch runs](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#batch)** —
  a `.batch.yaml` punch list runs many specs with `needs` ordering, a
  concurrency cap, and same-workspace auto-serialization.
- **[Extending it](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#extending)** —
  the whole system is four typed plug-in points (drivers, evaluators, task
  types, observers) plus declarative success criteria. Register your own and
  pass them in; the engine — and its guards — never change. New drivers are
  gated by a conformance harness (`loopgen verify-driver`).
- **[The interactive workshop](https://shortstackengineer.github.io/loop-generator/course/)** —
  seven modules that run the real engine code in the browser: step through
  scripted runs, build the prompts, red-team the guards.

## Examples

The [`examples/`](./examples) directory is a guided tour, ordered from the
offline `mock-demo` (no API key) up to full loop patterns — the Ralph Wiggum
loop, the evaluator-optimizer, and Osmani's discover → implement → verify
harness — plus self-contained projects. The
[examples index](./examples/README.md) is the map.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run coverage   # vitest + v8 coverage (gate: 85% lines/functions/statements, 80% branches)
npm run mutation   # Stryker mutation testing (gate: 60% mutation score)
```

## Status

v1 is the full framework: a working engine, the four extension points, the
conformance harness, five drivers (`mock`, `claude-agent-sdk`, `grok`,
`github-copilot`, `opencode`), the `command` + `experiment` evaluators, the
`jsonl` + `otlp` observers, and five task types (`function`, `api`, `webapp`,
`experiment`, `generic`). Task types beyond `function` ship with prompt
scaffolding and recommended evaluators; deepen them as you go.
