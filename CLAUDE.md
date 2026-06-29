# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`loop-generator` generates and runs **agent coding feedback loops**: a spec (`.loop.yaml`)
describes a task, a stack, an agent backend, and the tools that measure success;
the engine invokes the agent, runs the measurement tools, folds the results into
feedback, and re-invokes — until the success criteria pass or the iteration
budget runs out. The CLI is `loopgen`; the package also ships as a library.

## Commands

```bash
npm run dev -- <args>          # run the CLI from source (tsx), e.g. `npm run dev -- run examples/mock-demo.loop.yaml`
npm run loopgen -- <args>      # alias for the same thing
npm run typecheck              # tsc --noEmit (strict)
npm test                       # vitest run (whole suite)
npm run build                  # tsup → dist/ (then the `loopgen` bin works directly)
npm run coverage               # vitest + v8 coverage; gate 85% lines/functions/statements, 80% branches
npm run mutation               # Stryker mutation testing; gate 60% (break), 75% high
```

Single test / focused run (no dedicated script — call vitest directly):

```bash
npx vitest run test/engine.test.ts            # one file
npx vitest run -t "spec-tamper"               # by test name
npm run test:watch                            # watch mode
```

`loopgen` subcommands: `generate` (scaffold a spec, `-i` for interactive),
`run`, `batch`, `lint`, `list`, `verify-driver`. The offline smoke path that
needs no API key is `npm run dev -- run examples/mock-demo.loop.yaml` (scripted
`mock` driver).

## Architecture

The system is a small core with **three plug-in points**. Everything else is
built on them.

```
LoopSpec (.loop.yaml) → parseSpec → LoopEngine.run() → loop until success/maxIterations
                                          │
              ┌───────────────────────────┼────────────────────────────┐
          AgentDriver                  Evaluator[]                   TaskType
       (the coding agent)         (the feedback tools)         (prompt scaffolding)
```

- **`src/core/engine.ts`** — `LoopEngine`. The whole control flow lives here:
  resolve plug-ins → preflight → optional baseline eval → per-iteration loop
  (drive agent → snapshot/diff workspace → run evaluators → `evaluateCriteria` →
  `buildFeedback`) → terminal report. Read this first; `LoopReport.outcome` is
  the canonical list of how a run can end (`success | max-iterations |
  preflight-failed | aborted | error | baseline-vacuous | spec-tampered`).
- **`src/core/registry.ts` + `src/registry.ts`** — `Registry<T>` is a typed
  name→plug-in map. `createDefaultRegistries()` wires the built-ins; the engine
  takes the three registries as a constructor arg, so adding a plug-in is
  register-and-pass, never editing the engine.
- **Plug-in contracts** are the `types.ts` in each plug-in dir — read these
  before implementing one:
  - `src/drivers/types.ts` — `AgentDriver` (`name`, optional `preflight`, `run`).
    Built-ins: `mock`, `claude-agent-sdk`, `grok`, `github-copilot`. `run` returns an
    `AgentRunResult` with a `stopReason` (`completed|max_turns|aborted|error`)
    that the engine turns into honest warnings on otherwise-green runs.
  - `src/evaluators/types.ts` — `Evaluator` (a "feedback tool": measure the
    workspace, return `passed` + actionable `feedback`). Built-ins: `command`
    (anything with a CLI + exit code) and `experiment` (numeric metric vs
    threshold/baseline).
  - `src/tasks/types.ts` — `TaskType` (prompt scaffolding + recommended
    evaluators per category). **Advisory**: an unregistered `task.type` falls
    back to `genericTask`, so it never breaks a run. Built-ins: `function`,
    `api`, `webapp`, `experiment`, `generic`.
- **`src/core/spec.ts`** — the zod schema, `parseSpec`/`loadSpecFile`, and
  `resolveWorkspaceDir`. The `.loop.yaml` shape is defined here.
- **`src/core/criteria.ts`** — declarative success rules (`all-pass`, `pass`,
  `score`, `all`/`any`/`not`) over evaluator results.

### Trust guards (false-positive defense)

"All checks passed" is only meaningful if the checks exercise the requirement
and the agent did work. The engine has layered defenses — when touching the
engine, preserve them:

- **Change detection** (`src/core/workspace.ts`): each iteration is diffed via a
  throwaway git index (`snapshotTree`/`diffTrees`). A green run that changed no
  files is flagged. Build/runtime artifacts are excluded (`DEFAULT_IGNORE_GLOBS`
  + `workspace.ignore`). Falls back to driver-reported `changedFiles` when the
  workspace isn't a git repo.
- **Baseline eval** (`limits.baseline: true|"strict"`): runs checks before any
  agent work; if already green, the checks probably don't test the requirement.
  `"strict"` makes that a hard `baseline-vacuous` failure.
- **Sequential evaluators** (`evaluation.concurrency`, default 1): evaluators
  run one at a time so checks sharing external state (one DB) can't race.
- **Spec-integrity guard** (`limits.specGuard: off|warn|error`): the spec file
  is always excluded from the work diff; when it lives in the workspace it's
  hash-watched, and `error` mode turns a mid-run spec edit into a
  `spec-tampered` failure.

### Layer 0: lint (`src/lint/`)

Static pre-execution checks that catch a misconfigured spec in milliseconds
before any agent turn (`loopgen lint`). Rules live in `src/lint/rules.ts`;
those marked `preflight: true` ALSO run inside `engine.run()` preflight via
`workspacePreflight` (`src/lint/spec-lint.ts`). So a single rule can serve both
static lint and runtime validation — check that flag before assuming a rule is
lint-only.

### Batch (`src/batch/`)

`.batch.yaml` manifests run many specs with a dependency-aware scheduler
(`needs` ordering, `concurrency` cap, and a guarantee that two items resolving
to the same workspace never run concurrently — same-repo items auto-serialize).

### Conformance harness (`src/testing/`)

`runDriverConformance` drives a candidate `AgentDriver` against temp workspaces
and asserts the behavioral contract (reports a name, creates a requested file,
applies feedback across iterations, handles aborts). Exposed three ways: the
exported `loop-generator/testing` entry, the `loopgen verify-driver <name>` CLI,
and `test/conformance.test.ts`. This is the gate for any new driver.

## Conventions & constraints

- **ESM only** (`"type": "module"`), Node ≥ 20, TypeScript strict with
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type` for
  type-only imports).
- **zod is pinned to v4** (`^4.0.0`). This is a peer-dependency constraint from
  `@anthropic-ai/claude-agent-sdk` — do not downgrade to v3.
- **`@anthropic-ai/claude-agent-sdk` is an `optionalDependency`**, imported
  dynamically, and marked `external` in `tsup.config.ts` — never bundle it or
  make it a hard import. The package must install and run without it (that's
  what the `mock` driver and offline examples are for).
- **Public API is the barrel `src/index.ts`** (plus `src/testing/index.ts`).
  When you add an exportable plug-in or type, add it there; the README's
  "Extending it" section documents the contract users rely on.
- **Coverage/mutation exclude** `src/cli/**` (commander/inquirer wiring,
  smoke-tested via the built binary, not unit-coverable), barrel files, and
  `**/types.ts` (type-only). Don't chase coverage on those; do test core logic.

## In-repo skills (`.claude/skills/`)

Three skills encode the canonical workflows for this repo — prefer invoking them
over reinventing the steps:

- **author-loop** — create a verified `.loop.yaml` (interview → inspect repo for
  real commands → prove it's lint-clean and starts RED).
- **debug-loop** — diagnose a failed/stalled/suspicious run by its
  `LoopReport.outcome` and reproduce the failing check without spending agent
  budget.
- **add-driver** — scaffold a new `AgentDriver` and drive it to green against
  `loopgen verify-driver`.
