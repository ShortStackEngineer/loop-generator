# loop-generator

Generate and run agent coding feedback loops. You describe a task, the stack,
and the tools that measure success. The generator emits a reusable spec, and the
runner invokes a coding agent and re-invokes it, feeding back the measurement
results after each turn, until the goal is met or the iteration budget runs out.

```
LoopSpec (.loop.yaml) ──► LoopEngine ──► loop until success / maxIterations
                            │
        ┌───────────────────┼─────────────────────────┐
        ▼                   ▼                          ▼
   AgentDriver         Evaluator[]                 TaskType
  (the coding agent)  (the feedback tools)     (prompt scaffolding per category)
```

Each iteration follows the same path: drive the agent, run the evaluators, check
the success criteria, fold the results into feedback, and repeat. On git-backed
workspaces the feedback also includes a bounded diff of what the agent changed
last turn, so the next prompt reminds it of its own work.

## Concepts

| Piece | What it is | Built-ins |
|-------|-----------|-----------|
| **Driver** | Wraps a coding agent behind one interface | `claude-agent-sdk`, `grok`, `github-copilot`, `opencode`, `cursor`, `mock` |
| **Evaluator** | A "feedback tool" that measures the workspace and returns pass/fail + actionable feedback | `command`, `experiment` |
| **Task type** | Category knowledge: how to frame/instruct the agent and which evaluators to scaffold | `function`, `api`, `webapp`, `experiment`, `generic` |
| **Success criteria** | Declarative rule over evaluator results | `all-pass`, `pass`, `score`, `all`/`any`/`not` |

The generic `command` evaluator already covers tests, linters, type checkers,
and benchmarks: anything with a CLI and an exit code. The `experiment`
evaluator reads a numeric metric (from a command's JSON output or a file) and
compares it against thresholds or baselines, which suits A/B tests and
performance work.

## When to use it (and when not)

A loop is only as good as the checks you hand it. loop-generator shines where
success is mechanically checkable and misleads where it isn't, so it's worth
knowing which side of that line a task falls on before you spend agent budget.

**Works best when**

- The task is well-scoped and the repo already has (or you can add) real
  test/metric infrastructure.
- There's a specific suite to make green while keeping the rest green — e.g. a
  failing test that encodes the new behavior and turns green only when it's done.
- The target is a measurable number: keep p95 under X ms, coverage ≥ 90%, bundle
  under Y KB. (The `experiment` evaluator is built for this.)
- You're remediating against a concrete check across many call sites — add
  retries/logging/validation, fix a lint rule repo-wide, drag a flaky suite to
  green.

**Poor fit**

Tasks where the framework mostly ends up telling you the checks were the wrong
contract:

- "Improve the architecture," "make the UI delightful," "clean this up" — no
  exit-zero definition of done.
- Subjective or judgment-heavy work (API ergonomics, copy, visual polish): a
  passing check doesn't mean the outcome is good.
- Large, novel refactors with emergent design — the loop can't hold the whole
  design in mind across iterations, and the checks rarely capture "is this the
  right structure."

**What it can't solve**

These are fundamental to the agentic-loop approach, not gaps we plan to close.
The trust guards ([Trustworthy results](#trustworthy-results)) make them
*visible*; they don't eliminate them:

- **Mis-specified or insufficient checks.** The checks are the contract — bad
  checks, bad contract. A green run only ever means "the checks passed."
- **Agents that game metrics or ship minimal patches.** An agent can satisfy a
  surface check without doing the real work: hard-code the expected value, weaken
  an assertion, ship the narrowest patch that passes.
- **Context degradation over many iterations.** The agent re-derives state and
  drifts as the loop grows; feeding the last diff back into the next prompt
  mitigates this — it doesn't cure it.
- **The underlying unreliability of LLM agents on large, novel work.** More
  iterations don't turn an unreliable agent into a reliable one on a task it
  can't hold in its head.

If you can't write a check that's RED before the work and turns GREEN only when
the requirement is met, the task isn't ready for a loop. See
[Authoring a loop you can trust](./docs/authoring-loops.md) for how to prove that
up front, and [Debugging a run](./docs/debugging-loops.md) for when one goes
sideways.

## Install

```bash
npm install

# The Claude Agent SDK, Grok Build CLI, GitHub Copilot CLI, opencode, and Cursor CLI are optional backends.
# For real agent runs, set credentials for the driver you use:
export ANTHROPIC_API_KEY=...   # for claude-agent-sdk (or Claude login / Bedrock / Vertex)
export XAI_API_KEY=...         # for the grok driver (or run `grok` interactive login)
# github-copilot: install the `copilot` CLI and run it once to authenticate
#                 (or set GH_TOKEN / GITHUB_TOKEN for an unattended run)
# opencode: install the `opencode` CLI; runs against local models (e.g. LM Studio), no key needed
# cursor: install the `cursor` CLI and run `cursor agent login` once
#         (or set CURSOR_API_KEY for an unattended run)
```

## Quick start

Run the offline demo (no API key needed; it uses the scripted `mock` driver):

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
```

Generate a new loop and run it:

```bash
npm run loopgen -- generate -i                 # interactive
npm run loopgen -- generate -i --verify        # …and prove it's lint-clean + starts RED before you run
npm run loopgen -- run my-loop.loop.yaml
```

`--verify` encodes the authoring contract: after writing the spec it lints it and
runs the checks once with no agent turns, confirming they start **RED** (a green
check before any work probably doesn't test the requirement). Exit codes match
`lint`: `2` on lint errors, `1` on a vacuous/GREEN check set, else `0`.

List what's registered, or verify a driver:

```bash
npm run loopgen -- list
npm run loopgen -- verify-driver mock
```

(After `npm run build && npm link` — or a global install — you can use the
`loopgen` binary directly instead of `npm run loopgen -- <args>`.)

## The spec

```yaml
version: 1
name: add-retry-to-fetchUser
task:
  type: function
stack:
  language: typescript
  packageManager: npm
workspace:
  dir: ./target          # the directory the agent edits (relative to this file)
requirements: |
  Add exponential backoff (max 3 retries) to fetchUser(). Keep the signature.
driver:
  uses: claude-agent-sdk
  options:
    model: claude-opus-4-8
    maxTurns: 30
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
  baseline: false        # false | true | strict — run checks before the agent; "strict" fails a vacuous (already-green) check set
  specGuard: warn        # off | warn | error — what to do if the agent edits this spec file mid-run
  evaluatorGuard: warn   # off | warn | error — what to do if the agent edits the test files a check runs
  maxCostUsd: 5.0        # optional — stop with outcome "budget-exceeded" once cumulative driver-reported cost passes this
  maxTokens: 2000000     # optional — same, on cumulative input+output tokens (only enforced when the driver reports usage)
evaluation:
  concurrency: 1         # run evaluators sequentially (default; safe for shared DB/state)
```

## Examples

The [`examples/`](./examples) directory is a guided tour, ordered from the
simplest offline loop up to full loop patterns. The
[examples index](./examples/README.md) is the full map; the short version:

- **[Building blocks](./examples/building-blocks)** — start with the offline
  `mock-demo` (no API key), then one spec per mechanism: each driver, the
  `function` / `api` / `experiment` task types, and a batch run.
- **[Loop patterns](./examples/patterns)** — established patterns written as
  specs with the trust guards on: the Ralph Wiggum loop, the evaluator-optimizer,
  and Osmani's discover → implement → verify harness.
- **[Self-contained projects](./examples/projects)** — examples that run
  end-to-end without pointing at your own repo.

```bash
# offline, no API key:
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
```

## Lint before you run (`lint`)

A misconfigured spec can burn hours before failing for a reason that had nothing
to do with the agent. `loopgen lint` catches those statically, in milliseconds,
before any agent turn:

```bash
npm run loopgen -- lint my-feature.loop.yaml
npm run loopgen -- lint punch-list.batch.yaml      # lints the manifest + every item's spec
npm run loopgen -- lint my.loop.yaml --strict      # exit non-zero on warnings too
npm run loopgen -- lint my.loop.yaml --json        # machine-readable findings
```

It flags misconfigurations like a workspace that isn't the project you expect, a
check whose binary or script is missing, a destructive DB check with no test env,
and racy parallel checks. Exit codes: `2` on errors, `1` on `--strict` warnings,
else `0`. The error-severity workspace checks also run as part of every `run`
(skip with `--skip-preflight`).

→ **In depth: [every lint rule + exit codes](./docs/lint-and-trust.md#linting-before-you-run).**

## Trustworthy results

"All checks passed" is only meaningful if the checks actually exercise the new
requirement and the agent actually did something. The runner has layered
false-positive guards:

- **Change detection (git)** — flags a green run that changed no files (build and
  runtime artifacts excluded). Off-git (no repo, or a git-ignored workspace) it
  falls back to driver-reported files and the run always carries a `report.warnings`
  caveat that those changes can't be independently verified.
- **Baseline evaluation** (`limits.baseline`) — catches checks that already pass
  before any agent work; `"strict"` makes it a hard `baseline-vacuous` failure.
- **Sequential evaluators** (`evaluation.concurrency`, default 1) — checks that
  share external state can't race.
- **Spec-integrity guard** (`limits.specGuard`) — the agent can't fake a green by
  editing the spec's own success criteria (`spec-tampered`).
- **Evaluator-integrity guard** (`limits.evaluatorGuard`) — …or by editing the
  test files a check runs (`evaluator-tampered`).
- **Honest agent outcomes** — a `max_turns`/error stop is reported even when the
  checks happen to pass.

All caveats are collected in `report.warnings` and printed under `⚠ warnings:`.

→ **In depth: [how each guard works](./docs/lint-and-trust.md#trustworthy-results).**

## Workflows: authoring and debugging

Two step-by-step guides cover the disciplines that make loops pay off — the
judgment a flag can't encode:

- **[Authoring a loop you can trust](./docs/authoring-loops.md)** — interview the
  goal into something checkable, inspect the repo for the *real* test/build
  commands, then prove the spec is lint-clean and its checks start RED **before**
  spending any agent budget.
- **[Debugging a run](./docs/debugging-loops.md)** — diagnose a run by its
  `outcome` (a failed, stalled, errored, or suspiciously-green result),
  reproduce the failing check cheaply (lint + run it by hand, zero agent turns),
  and map the root cause to a concrete fix.

If you use Claude Code, the in-repo `author-loop` and `debug-loop` skills run
these workflows for you.

## Running a punch list (`batch`)

To run many units of work across one or more codebases, list them in a
`.batch.yaml` manifest and run them with one command:

```yaml
# punch-list.batch.yaml
version: 1
concurrency: 2          # items run in parallel up to this many...
continueOnError: true   # ...and a failure doesn't stop the others
defaults:
  maxIterations: 6      # merged into every item (item-level values win)
items:
  - name: add-retry
    spec: loops/add-retry.loop.yaml
    base: /repos/service-a            # which repo this item's workspace resolves in
  - name: fix-pagination
    spec: loops/fix-pagination.loop.yaml
    base: /repos/service-a
    needs: [add-retry]                # ordering: runs only after add-retry succeeds
  - name: dark-mode
    spec: loops/dark-mode.loop.yaml
    base: /repos/web
```

```bash
npm run loopgen -- batch punch-list.batch.yaml --report batch-report.json
# offline demo:  npm run loopgen -- batch examples/building-blocks/punch-list.batch.yaml
```

The scheduler honors `needs` ordering and the `concurrency` cap, and it
guarantees that two items resolving to the same workspace never run at once, so
parallelism is safe across distinct repos without one clobbering another
(same-repo items auto-serialize). A failed or skipped dependency cascades: its
dependents are skipped. You get a per-item summary (status · iterations · files ·
cost · warnings) and an aggregate JSON report, and the command exits non-zero if
any item failed. Items can also `inline:` a full spec instead of referencing a
file.

## Extending it

The whole system is three plug-in points. Register your own and pass them to the
engine.

### A new evaluator (feedback tool)

```ts
import { type Evaluator } from "loop-generator";

export const coverageEvaluator: Evaluator = {
  type: "coverage",
  async evaluate(ctx) {
    const pct = await measureCoverage(ctx.workdir);   // your logic
    return {
      passed: pct >= 0.9,
      score: pct,
      feedback: `coverage ${(pct * 100).toFixed(1)}% (need ≥ 90%)`,
    };
  },
};
```

### A new driver (agent backend)

Implement `AgentDriver`, then validate it against the conformance harness, which
exists for building and checking new integrations:

```ts
import { runDriverConformance, formatConformanceReport } from "loop-generator/testing";
import { myDriver } from "./my-driver";

const report = await runDriverConformance({ makeDriver: () => myDriver });
console.log(formatConformanceReport(report));   // ✓/✗ per behavioral contract
```

The harness drives your agent against temp workspaces and asserts the contract:
it reports a name, creates a requested file, applies feedback across iterations,
and handles aborts. Prompt-driven drivers (like the Claude SDK) work out of the
box; scripted drivers supply an `optionsFor` mapping. The CLI exposes it too:

```bash
npm run loopgen -- verify-driver claude-agent-sdk
```

### Use the engine as a library

```ts
import { LoopEngine, createDefaultRegistries, parseSpec } from "loop-generator";

const engine = new LoopEngine(createDefaultRegistries());
const report = await engine.run(parseSpec(spec), { baseDir: process.cwd() });
console.log(report.success, report.reason);
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

### Test quality

```bash
npm run coverage   # vitest + v8 coverage (gate: 85% lines/functions/statements, 80% branches)
npm run mutation   # Stryker mutation testing (gate: 60% mutation score)
```

## Status

v1 is the full framework skeleton: a working engine, the three extension points,
the conformance harness, the `mock` + `claude-agent-sdk` drivers, the `command` +
`experiment` evaluators, and four task types. Task types beyond `function` ship
with prompt scaffolding and recommended evaluators; deepen them as you go.
