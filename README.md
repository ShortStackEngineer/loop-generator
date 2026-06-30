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
the success criteria, fold the results into feedback, and repeat.

## Concepts

| Piece | What it is | Built-ins |
|-------|-----------|-----------|
| **Driver** | Wraps a coding agent behind one interface | `claude-agent-sdk`, `grok`, `github-copilot`, `mock` |
| **Evaluator** | A "feedback tool" that measures the workspace and returns pass/fail + actionable feedback | `command`, `experiment` |
| **Task type** | Category knowledge: how to frame/instruct the agent and which evaluators to scaffold | `function`, `api`, `webapp`, `experiment`, `generic` |
| **Success criteria** | Declarative rule over evaluator results | `all-pass`, `pass`, `score`, `all`/`any`/`not` |

The generic `command` evaluator already covers tests, linters, type checkers,
and benchmarks: anything with a CLI and an exit code. The `experiment`
evaluator reads a numeric metric (from a command's JSON output or a file) and
compares it against thresholds or baselines, which suits A/B tests and
performance work.

## Install

```bash
npm install
# The Claude Agent SDK, Grok Build CLI, and GitHub Copilot CLI are optional backends.
# For real agent runs, set credentials for the driver you use:
export ANTHROPIC_API_KEY=...   # for claude-agent-sdk (or Claude login / Bedrock / Vertex)
export XAI_API_KEY=...         # for the grok driver (or run `grok` interactive login)
# github-copilot: install the `copilot` CLI and run it once to authenticate
#                 (or set GH_TOKEN / GITHUB_TOKEN for an unattended run)
```

## Quick start

Run the offline demo (no API key needed; it uses the scripted `mock` driver):

```bash
npm run loopgen -- run examples/mock-demo.loop.yaml
```

Generate a new loop and run it:

```bash
npm run loopgen -- generate -i                 # interactive
npm run loopgen -- run my-loop.loop.yaml
```

List what's registered, or verify a driver:

```bash
npm run loopgen -- list
npm run loopgen -- verify-driver mock
```

(After `npm run build`, the `loopgen` binary is available directly.)

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
evaluation:
  concurrency: 1         # run evaluators sequentially (default; safe for shared DB/state)
```

See [`examples/`](./examples) for the building-block specs (function with the
Claude SDK, API with grok, experiment/A-B, and offline with mock) and for common
agent loops built declaratively: the
[Ralph Wiggum loop](./examples/ralph-loop.loop.yaml),
Anthropic's [evaluator-optimizer](./examples/evaluator-optimizer.loop.yaml), and
Osmani's [loop-engineering harness](./examples/osmani-harness.batch.yaml). The
[examples index](./examples/README.md) maps each pattern to a runnable spec.

## Lint before you run (`lint`)

A misconfigured spec can burn hours before failing for a reason that had nothing
to do with the agent. `loopgen lint` catches those statically, in milliseconds,
before any agent turn:

```bash
loopgen lint my-feature.loop.yaml
loopgen lint punch-list.batch.yaml      # lints the manifest + every item's spec
loopgen lint my.loop.yaml --strict      # exit non-zero on warnings too
loopgen lint my.loop.yaml --json        # machine-readable findings
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
  runtime artifacts excluded; falls back to driver-reported files off-git).
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
loopgen batch punch-list.batch.yaml --report batch-report.json
# offline demo:  loopgen batch examples/punch-list.batch.yaml
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
loopgen verify-driver claude-agent-sdk
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
