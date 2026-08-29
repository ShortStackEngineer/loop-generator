# loop-generator

**The loop runner that doesn't believe the agent.**

Anything can drive a coding agent in a loop until the checks go green — your
platform probably does it natively now. The hard problem is the other one:
*was the green earned?* loop-generator runs a coding agent against the checks
*you* define and then **audits the result** — it hash-watches the tests and the
spec, diffs the workspace for real work, can refuse runs whose checks were
already passing, and caps the spend. What comes back isn't the agent's word that
it finished; it's a `LoopReport` you can treat as evidence.

```
.loop.yaml ─► drive agent ─► audit work ─► run checks ─► fold feedback ─► LoopReport
 task+checks    any backend   diff+guards   the gate      + last diff      the verdict
```

One `.loop.yaml` spec describes the task, the stack, and the tools that measure
success. The engine drives the agent, audits and evaluates each iteration, folds
the results — including a bounded diff of what the agent changed last turn —
into the next prompt, and repeats until the checks pass with the guards quiet,
or the budget runs out. It's an agent-agnostic verifier: one honest scorecard
across `claude-agent-sdk`, `grok`, `github-copilot`, and `opencode` — the
harness auditing the agent isn't sold by the agent's vendor.

**Docs:** the full detail lives at
**<https://shortstackengineer.github.io/loop-generator/>** — this README is the
short version.

## Why it audits the agent

Reward hacking isn't hypothetical: [frontier coding models have been caught
special-casing tests, hard-coding expected values, and editing the very test
files that grade them](https://www.anthropic.com/research/emergent-misalignment-reward-hacking).
Most loop runners take the agent's word for it; loop-generator treats every
green as a claim to audit.

| An unattended agent can… | The guard that catches it | Result |
|--------------------------|---------------------------|--------|
| Edit the test files a check runs | Evaluator-integrity guard (hash-watched) | `evaluator-tampered` |
| Rewrite its own success criteria | Spec-integrity guard (hash-watched) | `spec-tampered` |
| Pass checks that were already green | Baseline evaluation (`baseline: strict`) | `baseline-vacuous` |
| Report "done" without changing anything | Workspace change detection (git-index diff) | vacuous-success warning |
| Grind the budget instead of converging | Cost / token ceilings | `budget-exceeded` |
| Crash while the checks happen to pass | Honest `stopReason` reporting | warning on the report |

"Done" is a rule over *your* evaluator results, never the model's opinion, and
a run ends with a `LoopReport`: one verdict, each iteration's evaluator results,
the diff of the real work, and every caveat the guards raised — green with
receipts, or an honest name for why not. How each guard works, and where each
has honest limits, is in the
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

Generate a new loop and run it:

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
  evaluators tell you *what* failed; the trace tells you *why the agent didn't
  fix it*. `--trace file.jsonl` for JSONL, or declare `jsonl` / `otlp` observers
  in the spec (standard OTLP spans, zero OTel dependency).
- **[Authoring](https://shortstackengineer.github.io/loop-generator/docs/authoring.html)
  and [debugging](https://shortstackengineer.github.io/loop-generator/docs/debugging.html) workflows** —
  interview the goal into something checkable and prove the spec RED before
  spending budget; diagnose a failed or suspiciously-green run by its `outcome`.
- **[Agent-assisted workflows](https://shortstackengineer.github.io/loop-generator/docs/authoring.html#skills)
  (`.claude/skills/`)** — the engine audits the run; these Claude Code skills
  produce checks worth auditing. The authoring pipeline: `frame-checks` (turn
  one request into falsifiable acceptance checks) → `author-loop` (a verified,
  lint-clean spec that starts RED). Plus `debug-loop` (diagnose a run by its
  `outcome` without spending agent budget) and `add-driver` (scaffold a new
  backend and drive it through `verify-driver`). They load automatically when
  you open this repo in Claude Code.
- **[Batch runs](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#batch)** —
  a `.batch.yaml` punch list runs many specs with `needs` ordering, a
  concurrency cap, and same-workspace auto-serialization.
- **[Extending it](https://shortstackengineer.github.io/loop-generator/docs/getting-started.html#extending)** —
  the whole system is four typed plug-in points (drivers, evaluators, task
  types, observers) plus declarative success criteria. Register your own and
  pass them in; the engine — and its guards — never change. New drivers are
  gated by a conformance harness (`loopgen verify-driver`).

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

The verification layer is the point; the loop is the chassis it rides on. v1 is
the full framework: a working engine, the four extension points, the conformance
harness, five drivers (`mock`, `claude-agent-sdk`, `grok`, `github-copilot`,
`opencode`), the `command` + `experiment` evaluators, the `jsonl` + `otlp`
observers, and five task types (`function`, `api`, `webapp`, `experiment`,
`generic`). Task types beyond `function` ship with prompt
scaffolding and recommended evaluators; deepen them as you go.
