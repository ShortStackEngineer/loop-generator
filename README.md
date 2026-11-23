---
kb_schema_version: "0.1"
product_name: "loop-generator"
maintainer: "TBD — requires confirmation by Maintainer (KD-DRAFT-001)"
last_reviewed: "TBD"
review_cadence_days: 180
verified_commit: "ccfd970"
authoritative_maps:
  context_map_ref: "TBD — requires confirmation by Domain Owner (KD-DRAFT-003)"
  domain_map_ref: "TBD — requires confirmation by Domain Owner (KD-DRAFT-004)"
  data_map_ref: "TBD — requires confirmation by Data Owner (KD-DRAFT-005)"
---

# loop-generator

> **Status:** Draft · **Maintainer:** TBD (KD-DRAFT-001)
> **Last reviewed:** TBD — human review pending (KD-DRAFT-002) · **Verified at:** `ccfd970`

## 1. Product purpose

**Declared:** loop-generator is a definition-of-done engine for coding agents
([package.json](package.json) @ `ccfd970`). **Implemented:** a TypeScript library
and Node CLI run an agent, evaluate its workspace, feed back failed checks, and
return a report when criteria pass or the run stops
([src/index.ts](src/index.ts), [src/core/engine.ts](src/core/engine.ts) @ `ccfd970`).

## 2. Supported business activities

These are implemented technical workflows; business outcomes and journey mapping
are **TBD — requires confirmation by Product Owner** (KD-DRAFT-006).

| Activity | Role of this repo | Evidence / Reference | Status |
| --- | --- | --- | --- |
| Define and inspect bounded coding work | Generate specs and lint them before execution | [src/cli/generate.ts](src/cli/generate.ts), [src/lint/index.ts](src/lint/index.ts) @ `ccfd970` | Implemented |
| Execute and assess agent work | Iterate agent, evaluators, criteria and feedback | [src/core/engine.ts](src/core/engine.ts) @ `ccfd970` | Implemented |
| Test the checks | Run known-good and faulty fixtures; optionally gate a loop before baseline | [src/check-validation/runner.ts](src/check-validation/runner.ts), [src/check-validation/gate.ts](src/check-validation/gate.ts) @ `ccfd970` | Implemented |
| Coordinate dependent loops | Schedule dependency-ready items with concurrency and workspace exclusion | [src/batch/runner.ts](src/batch/runner.ts) @ `ccfd970` | Implemented |
| Inspect run evidence | Write challenge packets and path indexes; look up a changed path without an agent | [src/core/challenge.ts](src/core/challenge.ts), [src/core/path-index.ts](src/core/path-index.ts), [src/cli/lookup.ts](src/cli/lookup.ts) @ `ccfd970` | Implemented |

## 3. System boundaries

- **Implemented — in scope:** spec parsing, driver/evaluator/task/observer registries,
  baseline and integrity checks, bounded iteration, feedback and run artifacts
  ([src/core/spec.ts](src/core/spec.ts), [src/registry.ts](src/registry.ts),
  [src/core/engine.ts](src/core/engine.ts) @ `ccfd970`).
- **Implemented — delegated:** real coding-agent execution uses the Claude Agent SDK
  or the Grok, Copilot and OpenCode CLIs; evaluator commands execute in the target
  workspace ([src/drivers/claude-agent-sdk.ts](src/drivers/claude-agent-sdk.ts),
  [src/drivers/grok.ts](src/drivers/grok.ts),
  [src/drivers/github-copilot.ts](src/drivers/github-copilot.ts),
  [src/drivers/opencode.ts](src/drivers/opencode.ts),
  [src/evaluators/command.ts](src/evaluators/command.ts) @ `ccfd970`).
- **Inferred — deployment boundary:** the published entry points are a CLI and
  library, rather than a hosted application API
  ([package.json](package.json), [src/cli/index.ts](src/cli/index.ts) @ `ccfd970`).
- **Context map reference:** TBD — requires confirmation by Domain Owner (KD-DRAFT-003).

## 4. Interfaces

| Interface | Direction | Protocol / Contract | Source evidence | Provenance |
| --- | --- | --- | --- | --- |
| `loopgen` CLI | Inbound | `run`, `generate`, `batch`, `lint`, `list`, `verify-driver`, `init-target`, `validate-checks`, `lookup` | [src/cli/index.ts](src/cli/index.ts) @ `ccfd970` | Implemented |
| Package API and testing subpath | Inbound | ESM exports, TypeScript types, driver conformance helpers | [package.json](package.json), [src/index.ts](src/index.ts), [src/testing/index.ts](src/testing/index.ts) @ `ccfd970` | Declared + Implemented |
| Loop and batch specs | Inbound | YAML/JSON parsed with Zod schemas | [src/core/spec.ts](src/core/spec.ts), [src/batch/manifest.ts](src/batch/manifest.ts) @ `ccfd970` | Implemented |
| Check-validation manifest | Inbound | Version 1 claims, checks, control, counterexamples and exit-code rules | [src/check-validation/manifest.ts](src/check-validation/manifest.ts) @ `ccfd970` | Implemented |
| Plug-in contracts | Outbound invocation | Typed driver, evaluator, task and observer methods | [src/drivers/types.ts](src/drivers/types.ts), [src/evaluators/types.ts](src/evaluators/types.ts), [src/tasks/types.ts](src/tasks/types.ts), [src/observers/types.ts](src/observers/types.ts) @ `ccfd970` | Implemented |
| Reports and local run artifacts | Outbound | `LoopReport`; JSON challenge packet and path index; optional JSON report and JSONL trace | [src/core/engine.ts](src/core/engine.ts), [src/core/challenge.ts](src/core/challenge.ts), [src/core/path-index.ts](src/core/path-index.ts), [src/cli/run.ts](src/cli/run.ts) @ `ccfd970` | Implemented |
| OTLP observer | Outbound | OTLP JSON file; optional HTTP POST to configured traces endpoint | [src/observers/otlp.ts](src/observers/otlp.ts) @ `ccfd970` | Implemented |

## 5. Domain terms

Definitions below describe local implementation; enterprise glossary alignment is
**TBD — requires confirmation by Domain Owner** (KD-DRAFT-004).

| Term | Local definition | Source / provenance |
| --- | --- | --- |
| Loop spec | Requirements, workspace, driver, evaluators, criteria and limits | [src/core/spec.ts](src/core/spec.ts) @ `ccfd970` — Implemented |
| Evaluator | Plug-in returning pass/fail, feedback and optional score | [src/evaluators/types.ts](src/evaluators/types.ts) @ `ccfd970` — Implemented |
| Success criteria | Rule over evaluator results, including all-pass and composed score/pass rules | [src/core/criteria.ts](src/core/criteria.ts) @ `ccfd970` — Implemented |
| Baseline | Pre-agent evaluation; strict mode rejects an already-satisfied contract as `baseline-vacuous` | [src/core/engine.ts](src/core/engine.ts) @ `ccfd970` — Implemented |
| Challenge packet | Latest run's requirements, identity, outcome, checks, changed paths and warnings | [src/core/challenge.ts](src/core/challenge.ts) @ `ccfd970` — Implemented |
| Path index | Accumulated changed-path/hash/run/iteration tuples used by lookup | [src/core/path-index.ts](src/core/path-index.ts) @ `ccfd970` — Implemented |

## 6. Data responsibilities

Roles describe local handling, not authoritative ownership. Data Map visibility is
**TBD — requires confirmation by Data Owner** (KD-DRAFT-005).

| Data entity / state | Role | Authoritative owner (per Data Map) | Evidence / provenance |
| --- | --- | --- | --- |
| Specs and check fixtures | Consumer | Unconfirmed — KD-DRAFT-010 | [src/core/spec.ts](src/core/spec.ts), [src/check-validation/fixtures.ts](src/check-validation/fixtures.ts) @ `ccfd970` — Implemented |
| Target workspace and optional git checkpoints | Consumer / Store; driver receives workspace for edits | Unconfirmed — KD-DRAFT-011 | [src/core/engine.ts](src/core/engine.ts), [src/core/workspace.ts](src/core/workspace.ts) @ `ccfd970` — Implemented |
| Reports, outcomes and error states | Producer | Unconfirmed — KD-DRAFT-012 | [src/core/engine.ts](src/core/engine.ts) @ `ccfd970` — Implemented |
| `.loopgen/challenge.json` | Producer / Store; replaced each run | Unconfirmed — KD-DRAFT-013 | [src/core/challenge.ts](src/core/challenge.ts) @ `ccfd970` — Implemented |
| `.loopgen/path-index.json` | Producer / Consumer / Store; merges prior entries | Unconfirmed — KD-DRAFT-014 | [src/core/path-index.ts](src/core/path-index.ts) @ `ccfd970` — Implemented |
| Trace records and OTLP payloads | Producer / Store; optional downstream export | Unconfirmed — KD-DRAFT-015 | [src/observability/recorder.ts](src/observability/recorder.ts), [src/observers/otlp.ts](src/observers/otlp.ts) @ `ccfd970` — Implemented |

## 7. Dependencies

Direction is relative to the engine: upstream supplies runtime/input; downstream
is invoked or receives output. It does not imply team ownership.

| Dependency | Direction | Purpose | Evidence | Provenance |
| --- | --- | --- | --- | --- |
| Node.js >=20 | Upstream | Runtime requirement; CI uses Node 20/22 | [package.json](package.json), [.github/workflows/ci.yml](.github/workflows/ci.yml) @ `ccfd970` | Declared |
| Commander, Inquirer, YAML, Zod | Upstream | CLI, interactive prompts, parsing and schemas | [package.json](package.json), [src/cli/index.ts](src/cli/index.ts), [src/cli/generate.ts](src/cli/generate.ts), [src/core/spec.ts](src/core/spec.ts) @ `ccfd970` | Declared + Implemented |
| Optional Claude Agent SDK; Grok, Copilot and OpenCode CLIs | Downstream | Execute real coding agents | [src/drivers/claude-agent-sdk.ts](src/drivers/claude-agent-sdk.ts), [src/drivers/grok.ts](src/drivers/grok.ts), [src/drivers/github-copilot.ts](src/drivers/github-copilot.ts), [src/drivers/opencode.ts](src/drivers/opencode.ts) @ `ccfd970` | Implemented |
| Workspace commands and git | Downstream | Evaluate checks and track workspace changes/checkpoints | [src/evaluators/command.ts](src/evaluators/command.ts), [src/core/workspace.ts](src/core/workspace.ts) @ `ccfd970` | Implemented |
| Optional OTLP collector | Downstream | Receive trace payload over HTTP | [src/observers/otlp.ts](src/observers/otlp.ts) @ `ccfd970` | Implemented |

## 8. Owner references

- **Maintainer:** TBD — requires confirmation by Maintainer (KD-DRAFT-001).
- **Product owner:** TBD — requires confirmation by Product Owner (KD-DRAFT-007).
- **Delivery team:** TBD — requires confirmation by Domain Owner (KD-DRAFT-008).
- **Escalation / routing channel:** TBD — requires confirmation by Maintainer (KD-DRAFT-009).

No authoritative maps or ownership service were available in the connected tool
inventory or supplied materials. Repository identity is not ownership evidence.
All gaps are local drafts in [Knowledge Debt](docs/knowledge-debt.yaml).

## Known visibility limits & open conflicts

This bootstrap inspected committed source at `ccfd970`, not runtime telemetry,
external map repositories, real-provider runs or hosted documentation. The original
checkout has unrelated uncommitted README/site edits; this separate worktree does
not incorporate or alter them. Full scope and migration inventory:
[authoring report](docs/kb-authoring-report.md).

- **KD-DRAFT-016 — evaluator protection:** the preserved README says "All of it
  is on by default" and "The tests the checks run were not edited". **Implemented:**
  error mode is the default, but only resolved files are watched; bare `npm test`
  names no files, so use explicit `evaluators[].guard` paths. The spec is watched
  only when its path is supplied and lies inside the workspace
  ([src/core/spec.ts](src/core/spec.ts), [src/core/evaluator-guard.ts](src/core/evaluator-guard.ts),
  [src/core/engine.ts](src/core/engine.ts) @ `ccfd970`).
- **KD-DRAFT-017 — usage ceilings:** the preserved README says "Spend stayed under
  a ceiling you set". **Implemented:** usage is driver-reported, can be absent,
  and is checked after iterations; success takes precedence over the usage-limit
  stop. Limits can overshoot ([src/core/engine.ts](src/core/engine.ts) @ `ccfd970`).
- **KD-DRAFT-018 — version language:** the preserved Status section calls this
  "v1"; the package declares `0.1.3`, while CLI `--version` is `0.1.0`. These
  may describe different milestones; a maintainer must clarify
  ([package.json](package.json), [src/cli/index.ts](src/cli/index.ts) @ `ccfd970`).
- **KD-DRAFT-002 — review date:** no human review date exists in the prior README.
  `last_reviewed` stays `TBD`. The bundled validator treats this legitimate draft
  gap as an error, so an overall pass requires human review and an actual date.

## Additional repository documentation

The original README narrative, examples and operational instructions follow
verbatim, with headings shifted down one level. Technical statements in this
preserved material are **Declared** at `ccfd970`; the qualifications above remain
open for human review. External links and historical experiment claims were
preserved, not independently revalidated.

### Original overview

**Write the definition of done. Any agent does the work. You get the receipt.**

loop-generator is a definition-of-done engine for coding agents. You write the
checks — tests, type checks, a metric with a threshold — that are RED today and
go GREEN only when the work is really finished. Claude, Grok, Copilot, or a
local model works until they pass. And the run ends in a report you can hand
to a reviewer, not the agent's word that it's done.

```
$ npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml

[loopgen] running baseline evaluation (no agent) — disable with limits.baseline: false
[loopgen:iter0] starting iteration 1/5
  iter 1: retry — agent ok — ✗ answer-check · 1 file(s)
[loopgen:iter0] result: not yet — failing: answer-check
[loopgen:iter1] starting iteration 2/5
  iter 2: PASS — agent ok — ✓ answer-check · 1 file(s)
[loopgen:iter1] result: PASS — all checks passed

✓ SUCCESS — mock-demo
outcome: success — all checks passed
baseline: checks fail as expected — failing: answer-check
iterations: 2, time: 0.0s
changed: 1 file(s)
```

That's the offline demo — no API key, a scripted `mock` agent — and it is the
shape of the whole product: a check fails, the agent gets the failure back, the
check passes, and the run ends in an outcome you didn't have to take on faith.
(Abridged: the real run also prints a warning that its workspace isn't a git
repo, so change detection fell back to content hashes and there's no unified
diff. That caveat is part of the receipt — a thinner receipt says so.)

**Docs:** the full detail lives at
**<https://shortstackengineer.github.io/loop-generator/>** — this README is the
short version.

### How it works

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

### Why the green is earned

Reward hacking isn't hypothetical: [frontier coding models have been caught
special-casing tests, hard-coding expected values, and editing the very test
files that grade them](https://www.anthropic.com/research/emergent-misalignment-reward-hacking).
Most loop runners take the agent's word for it. This one treats every green as
a claim to be checked — and the report tells you what it checked.

All of it is on by default. The one thing you have to add yourself is a spend
ceiling, because only you know the number.

| The report can tell you… | How | If it isn't true |
|--------------------------|-----|------------------|
| The checks were RED before the work began | Baseline evaluation (`baseline: strict`, default) | run fails before any agent turn: `baseline-vacuous` |
| The tests the checks run were not edited | Evaluator-integrity guard (hash-watched; `error`, default) | run fails: `evaluator-tampered` |
| The success criteria were not rewritten | Spec-integrity guard (hash-watched; `error`, default) | run fails: `spec-tampered` |
| Real files changed, not just build output | Workspace change detection (git-index diff) | warning on the green run |
| The agent actually finished its last turn | Honest `stopReason` from the driver | warning on the green run |
| Spend stayed under a ceiling you set | `maxCostUsd` / `maxTokens` (opt-in) | run stops: `budget-exceeded` |

Each guard can be loosened per spec — `baseline: false` when your checks have
side effects that must not run twice, `warn` when you want the caveat without
the failure — and the report says which posture the run used.

"Done" is a rule over *your* check results, never the model's opinion. How each
guard works — and where each has honest limits — is in
[why the green is earned](https://shortstackengineer.github.io/loop-generator/docs/trust.html).

### Install

```bash
npm install
# The Claude Agent SDK, Grok Build CLI, GitHub Copilot CLI, and opencode are optional backends.
# For real agent runs, set credentials for the driver you use:
export ANTHROPIC_API_KEY=...   # for claude-agent-sdk (or Claude login / Bedrock / Vertex)
export XAI_API_KEY=...         # for the grok driver (or run `grok` interactive login)
# github-copilot: install the `copilot` CLI and run it once to authenticate
# opencode: install the `opencode` CLI; runs against local models, no key needed
```

#### Local models (LM Studio / Ollama)

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

### Quick start

Run the offline demo (no API key needed; it uses the scripted `mock` driver):

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
```

Then run it again. The second run fails with `baseline-vacuous` after zero
agent iterations: the answer is already in the workspace, so the check is green
before any work and there is nothing for the agent to earn. That's the strict
baseline doing its job — and it's why a green you didn't watch is still worth
something. Reset with `rm -rf examples/building-blocks/.workspace`.

Ask the same question of the checks themselves, offline, with a known-good
fixture and a deliberately wrong one:

```bash
npm run loopgen -- validate-checks examples/check-validation/strong.checks.yaml --report /tmp/strong.json
npm run loopgen -- validate-checks examples/check-validation/weak.checks.yaml --report /tmp/weak.json
```

The strong check rejects the faulty fixture (`validated`). The weak check
accepts everything, so the counterexample escapes (`gaps`). A crash that
exits `1` looks like a rejection under the default `rejectExitCodes: [1]`;
use a distinct code (for example `10`) if you need unexpected exits to
classify as errors. Details: [Validating the checks](./docs/check-validation.md). To require that
evidence before an ordinary `loopgen run`, set `checkValidation.manifest` on
the spec ([inside a loop](./docs/check-validation-integration.md)).

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

### The spec

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

The three guard lines are the schema defaults, spelled out; `loopgen generate`
writes them so the spec reads as a contract without consulting the docs. Drop
`baseline` to `false` only when your checks have side effects that must not run
twice. Every field, evaluator option, and success rule is documented in
[the spec reference](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#spec).

### From one loop to a whole app

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

### When to use it

Use it where success is mechanically checkable and the run is unattended:
a failing test to make green (while keeping the rest green), a measurable
target (p95 under X ms, coverage ≥ 90%), or a concrete check applied across
many call sites. If you can't write a check that's RED before the work and
turns GREEN only when the requirement is met, the task isn't ready for a loop —
"improve the architecture" and other judgment-heavy work will only tell you the
checks were the wrong contract. The guards make bad checks, gamed metrics, and
agent drift *visible*; they don't eliminate them. The full fit guide is in
[when a loop fits](https://shortstackengineer.github.io/loop-generator/docs/authoring.html#fit).

### Going deeper

- **[Why the green is earned](https://shortstackengineer.github.io/loop-generator/docs/trust.html)** —
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
- **[Validating the checks](./docs/check-validation.md)** —
  `loopgen validate-checks` runs your checks against a known-good fixture and
  explicit faulty ones (a fresh copy per check, not one shared copy). A weak
  check shows up as an escaped counterexample; a broken harness is an error,
  never a catch — but exit codes alone cannot distinguish an assertion
  failure from a crash when both exit `1`. This does not change how existing
  `.loop.yaml` runs succeed. Opt in on a spec with `checkValidation.manifest`
  to run the same gate before baseline or any agent turn
  ([inside a loop](./docs/check-validation-integration.md)).
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

### Examples

The [`examples/`](./examples) directory is a guided tour, ordered from the
offline `mock-demo` (no API key) up to full loop patterns — the Ralph Wiggum
loop, the evaluator-optimizer, and Osmani's discover → implement → verify
harness — plus self-contained projects. The
[examples index](./examples/README.md) is the map.

### Development

```bash
npm run typecheck
npm test
npm run test:acceptance       # build + black-box CLI acceptance checks
npm run build
npm run coverage   # vitest + v8 coverage (gate: 85% lines/functions/statements, 80% branches)
npm run mutation   # Stryker mutation testing (gate: 70% mutation score)
```

### Status

v1 is the full framework: a working engine, the four extension points, the
conformance harness, five drivers (`mock`, `claude-agent-sdk`, `grok`,
`github-copilot`, `opencode`), the `command` + `experiment` evaluators, the
`jsonl` + `otlp` observers, and five task types (`function`, `api`, `webapp`,
`experiment`, `generic`). Task types beyond `function` ship with prompt
scaffolding and recommended evaluators; deepen them as you go.
