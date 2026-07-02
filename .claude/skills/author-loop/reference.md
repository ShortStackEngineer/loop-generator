# author-loop reference

Lookup tables for the spec schema, evaluators, task types, trust knobs, and lint
rules. The workflow lives in `SKILL.md`; come here when you need exact field
names, defaults, or a lint-rule → fix mapping.

Source of truth in the repo: `src/core/spec.ts` (schema), `src/tasks/base.ts`
and `src/tasks/builtin.ts` (task types + default commands), `src/lint/rules.ts`
(lint rules). If anything here disagrees with the code, the code wins — re-read
it.

## Spec cheat-sheet (`.loop.yaml`)

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `version` | — | `1` | Literal `1`. |
| `name` | **yes** | — | Non-empty. Slugified for the default filename. |
| `description` | no | — | Free text. |
| `task.type` | — | `function` | One of the registered task types (below) or any string (falls back to `generic`). |
| `stack.language` | yes if `stack` present | — | Drives the default test/check commands. |
| `stack.framework` | no | — | e.g. `express`, `react`. |
| `stack.packageManager` | no | — | e.g. `npm`, `pnpm`, `poetry`. |
| `workspace.dir` | — | `.` | The dir the agent edits, **relative to the spec file**. |
| `workspace.snapshot` | — | `none` | `none` \| `git` (git-snapshot before the run). |
| `workspace.ignore` | — | `[]` | Extra globs excluded from change-detection. |
| `requirements` | **yes** | — | Natural-language spec of what to build. Make it concrete and testable. |
| `driver.uses` | **yes** | — | `claude-agent-sdk` \| `grok` \| `github-copilot` \| `opencode` \| `mock` (or a custom driver). See Drivers below. |
| `driver.options` | — | `{}` | Driver-specific (`model`, `maxTurns`, `resume`, and a headless auto-approve flag — see Drivers below). |
| `evaluators` | — | `[]` | The feedback tools. Each: `{ uses, as?, options, guard? }` (`guard` = files the evaluator-integrity guard watches). |
| `success` | — | `{ type: all-pass }` | See success criteria below. |
| `limits.maxIterations` | — | `5` | Positive integer; the agent-turn budget. |
| `limits.iterationTimeoutMs` | no | — | Per-iteration timeout. |
| `limits.baseline` | — | `false` | `false` \| `true` \| `"strict"` — pre-run vacuity check. |
| `limits.specGuard` | — | `warn` | `off` \| `warn` \| `error` — if the agent edits the spec mid-run. |
| `limits.evaluatorGuard` | — | `warn` | `off` \| `warn` \| `error` — if the agent edits a guarded check/data file mid-run. |
| `limits.maxCostUsd` | no | — | Cap cumulative driver-reported cost; a non-converging iteration past it stops with `budget-exceeded`. |
| `limits.maxTokens` | no | — | Same ceiling on input+output tokens combined. |
| `evaluation.concurrency` | — | `1` | Evaluators run sequentially by default. |
| `prompts.system/initial/iteration` | no | — | Override the task type's generated prompts. |

## Success criteria forms (`success:`)

| Form | Meaning |
|------|---------|
| `{ type: all-pass }` | Every evaluator must pass. |
| `{ type: pass, evaluators: [a, b] }` | Named evaluators must pass (by `as`/type). |
| `{ type: score, evaluator: x, gte?, lte?, eq? }` | Numeric threshold on one evaluator's `score`. |
| `{ type: all, of: [...] }` | All sub-criteria. |
| `{ type: any, of: [...] }` | Any sub-criterion. |
| `{ type: not, of: ... }` | Negation. |

## Drivers — the built-ins and their headless flags

`driver.uses` picks the agent backend; `driver.options` is driver-specific. For an
*unattended* loop each real driver needs its auto-approve flag set, or it blocks on
an interactive permission prompt and the iteration times out.

| `driver.uses` | Needs | Headless flag (in `options`) | Common options |
|---------------|-------|------------------------------|----------------|
| `claude-agent-sdk` (default) | `@anthropic-ai/claude-agent-sdk` + `ANTHROPIC_API_KEY` (or Claude login) | none — the SDK runs headless | `model`, `maxTurns`, `resume` |
| `grok` | `grok` CLI + `XAI_API_KEY` (or cached login) | `alwaysApprove: true` | `model`, `maxTurns`, `resume`, `env` |
| `github-copilot` | `copilot` CLI, authenticated (or `GH_TOKEN`/`GITHUB_TOKEN`) | `allowAllTools: true` | `model`, `reasoningEffort`, `resume`, `env` |
| `opencode` | `opencode` CLI + a configured provider (e.g. local LM Studio) | `dangerouslySkipPermissions: true` | `model` (needs a provider prefix, e.g. `lmstudio/…`), `agent`, `variant`, `pure`, `resume`, `env` |
| `mock` | nothing (offline) | n/a | `steps` (scripted per-iteration file writes) |

Real-driver options are CLI-version dependent — confirm against the driver's
`src/drivers/*.ts` and the building-block example for that driver
(`examples/building-blocks/{api-feature-grok,copilot-feature,opencode-feature}.loop.yaml`)
before relying on an option.

## Built-in task types → recommended evaluators

`recommendedEvaluators` is what `loopgen generate` scaffolds. You will usually
**replace the generic commands with the repo's real ones** (see next table).

| `task.type` | Frames the agent as | Scaffolds |
|-------------|---------------------|-----------|
| `function` | implementing a precise, tested function/module | tests + static-check |
| `api` | implementing an API/endpoint with contract + integration coverage | tests + static-check |
| `webapp` | implementing a UI feature that builds and behaves | tests + static-check + `build` (`npm run build`) |
| `experiment` | converging on a measurable metric | tests + static-check + `experiment` metric (`metrics.json`) |
| `generic` | a generic coding task, no category guidance | tests + static-check |

## Default per-language commands (the generic scaffold)

These come from `languageCommands()`. They are *defaults*, frequently wrong for a
specific repo — confirm against the repo's real scripts (`package.json`,
`pyproject.toml`, `Makefile`, `Cargo.toml`, `go.mod`).

| language | test | static-check |
|----------|------|--------------|
| typescript | `npm test` | `npx tsc --noEmit` |
| javascript | `npm test` | `npx eslint .` |
| python | `pytest -q` | `ruff check .` |
| rust | `cargo test` | `cargo clippy -- -D warnings` |
| go | `go test ./...` | `go vet ./...` |
| java | `mvn -q test` | — |
| ruby | `bundle exec rspec` | — |
| *(anything else)* | `echo 'configure your test command' && false` | — |

If you see the `echo ... && false` placeholder in a generated spec, the language
wasn't recognized — set a real test command yourself.

## Evaluator options

Each `evaluators[]` entry is `{ uses, as?, options, guard? }`. `guard` lists files
the evaluator-integrity guard watches (see Trust knobs) — the check's own
test/scorer/data files — so the agent can't move the metric by editing what grades
it. Files named in a bare runner (`npm test`) aren't auto-detected; name them in
`guard` explicitly.

**`command`** — run a CLI, judge by exit code; optionally parse a numeric score.
```yaml
- uses: command
  as: tests                 # display name; also how `success.pass`/`score` refer to it
  options:
    command: npm test       # the shell command
    cwd: ./sub              # optional; relative to workspace.dir
    expectExitCode: 0       # optional; default 0
    timeoutMs: 120000       # optional
    env: { CI: "1" }        # optional extra env
    scoreRegex: "coverage: ([0-9.]+)"   # optional; capture group → score
    scoreGte: 85            # optional; pass also requires score >= this …
    scoreLte: 100           # optional; … and/or <= this
  guard: [test]             # optional; files this check depends on
```

**`experiment`** — read a numeric metric and compare to thresholds and/or a baseline.
```yaml
- uses: experiment
  as: latency
  options:
    command: npm run bench --silent   # prints JSON on stdout …
    metricsFile: metrics.json         # … OR read the metric from a file (need one of the two)
    metric: p95_ms          # dot-path into the JSON, e.g. "variantB.conversion"
    direction: decrease     # increase | decrease — what "better" means (default increase)
    baseline: 0.18          # optional; a known value to compare against
    minDelta: 0.02          # optional; required absolute improvement over baseline
    minValue: 0.8           # optional; absolute floor
    maxValue: 150           # optional; absolute ceiling
    timeoutMs: 600000       # optional
  guard: [eval, data]       # optional; guard the scorer + labeled data
```
The metric value is exposed as `score`, so pair it with `success: { type: score,
evaluator: latency, gte/lte: … }` for a numeric gate.

## Trust knobs — when to set what

- **`limits.baseline: "strict"`** — use when the checks *should* be RED before any
  work (the normal case for a new requirement). The run fails fast with
  `baseline-vacuous` if they already pass, which means the checks don't test the
  requirement. Leave `false` only when checks side-effect (db migrate/seed) and
  can't be run twice cheaply.
- **`limits.specGuard: "error"`** — set when the spec file lives **inside**
  `workspace.dir` (the agent could edit its own success criteria). Best practice
  is to keep the spec *outside* the target repo and leave `warn`.
- **`limits.evaluatorGuard: "error"` + `evaluators[].guard`** — the *checker's* own
  integrity, the counterpart to `specGuard`. List the files a check grades against
  in its `guard:` (the scorer, the test dir, the labeled/held-out data); `error`
  makes a mid-run edit to any of them abort as `evaluator-tampered`. This is what
  keeps "optimize until the metric passes" honest — the agent's only lever becomes
  the code under test, not the grader. Use it on every metric/eval loop; leave the
  `warn` default when nothing about the checks is gameable.
- **`limits.maxCostUsd` / `limits.maxTokens`** — a spend ceiling. The engine sums
  driver-reported usage across iterations and stops a non-converging run with
  `budget-exceeded` rather than funding another turn (a satisfied iteration always
  reports `success` first; getting the result is never penalized). An
  un-instrumented driver reports no usage and can never trip it. `maxTokens` counts
  input + output combined.
- **`evaluation.concurrency`** — keep at `1` for checks that share state (one DB,
  one dev server). Raise only for genuinely independent checks.
- **`workspace.snapshot: git`** — snapshot before the run when you want a clean
  rollback point. `workspace.ignore` — add globs for generated artifacts so a
  green run that only touched build output isn't counted as real work.

## Lint rules → what they mean → how to fix

Run `loopgen lint <spec> --strict`. Resolve every `✗` (error) and `⚠` (warning).

| Rule | Sev | Fix |
|------|-----|-----|
| `SPEC-WORKDIR-MISSING` | warn | The workspace dir doesn't exist yet (engine will create it). Fine for greenfield; otherwise the path is wrong. |
| `SPEC-WORKDIR-NOT-PROJECT` | **error** | Resolved workspace isn't a git repo and has no stack markers. Usually a compounded relative path (e.g. `../..` twice landing in `$HOME`). Fix `workspace.dir` / batch `base`. |
| `SPEC-EVAL-BINARY-MISSING` | **error** | A command whose leading binary is a **project-local path** (`./script.sh`, `bin/foo`) doesn't exist at its cwd. Fix the path. (Bare PATH commands like `npm`/`pytest` are *not* checked — a wrong bare command won't be caught statically and will fail at runtime, so confirm those by hand.) |
| `SPEC-EVAL-FILE-MISSING` | warn | A check references a script/file that doesn't exist. Create it or fix the path. |
| `SPEC-EVAL-DESTRUCTIVE-ENV` | warn | A check mutates a DB without a test env — it would alter dev data each iteration. Point it at a test DB. |
| `SPEC-EVAL-SHARED-RESOURCE` | warn | Multiple stateful checks with `concurrency > 1` can race. Drop to `concurrency: 1`. |
| `SPEC-EVAL-CWD-MIXED` | warn | Some checks use absolute `cd`, others bare project commands. Make cwd handling consistent. |
| `SPEC-SMOKE-SELF-FULFILLING` | warn | A smoke creates records directly but never hits a real endpoint — it can pass without exercising the feature. Drive the real endpoint. |
| `SPEC-REQ-UNVERIFIED-ARTIFACT` | info | Requirements mention updating docs/data but no evaluator verifies it. Add a check or accept the gap. |
| `SPEC-BASELINE-RECOMMENDED` | info | There's a smoke but no baseline evaluation. Set `limits.baseline: true`/`"strict"`. |

Batch manifests add `BATCH-MAXITER-OVERRIDE`, `BATCH-NEEDS-AS-ORDERING`,
`BATCH-FAILFAST-CHAIN`, `BATCH-SPEC-LOAD`, `BATCH-INVALID`.

## Batch manifests (`.batch.yaml`)

Run many specs together with dependency ordering and bounded concurrency
(`src/batch/manifest.ts`). Same-workspace items never run concurrently
(auto-serialized), so a maker→checker chain on one repo is safe. Lint a manifest
like a spec (`loopgen lint x.batch.yaml`); if items point at a `./target` that
doesn't exist yet you'll get the expected workspace warning, so don't add `--strict`.

| Field | Level | Notes |
|-------|-------|-------|
| `name` | manifest | Optional label. |
| `concurrency` | manifest | Max items at once (default 1). Same-workspace items serialize regardless. |
| `continueOnError` | manifest | `true` (default) keeps going after a failure; `false` stops scheduling new items. |
| `defaults` | manifest | Shared `base` / `maxIterations` / `baseline` / `skipPreflight` applied to every item. `osmani-harness` sets `defaults.base: ./target` once and each sub-spec uses `workspace.dir: .`. |
| `items[]` | — | One entry per loop; at least one required. |
| `items[].name` | item | **Unique** — used in `needs` and the report. |
| `items[].spec` \| `items[].inline` | item | **Exactly one**: a path to a `.loop.yaml`, or an inline spec (a full loop spec). |
| `items[].needs` | item | Names of items that must succeed first — ordering *and* a failure cascade. |
| `items[].base` / `maxIterations` / `baseline` / `skipPreflight` | item | Per-item overrides. |

There's no `generate` for batches — copy `examples/building-blocks/punch-list.batch.yaml`
(inline items) or `examples/patterns/osmani-harness.batch.yaml` (`spec:` files +
`defaults.base`), and point `spec:` items at `.loop.yaml` files you've already
verified individually. Batch lint rules are listed under Lint rules above.

## Invoking the CLI

From the loop-generator repo root, no build needed:
```bash
npm run loopgen -- <args>      # e.g. npm run loopgen -- lint my.loop.yaml --strict
```
After `npm run build`, the `loopgen` binary is on PATH:
```bash
loopgen <args>
```
