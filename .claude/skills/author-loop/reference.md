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
| `driver.uses` | **yes** | — | `claude-agent-sdk` \| `grok` \| `mock` (or a custom driver). |
| `driver.options` | — | `{}` | Driver-specific (e.g. `model`, `maxTurns`, `resume`). |
| `evaluators` | — | `[]` | The feedback tools. Each: `{ uses, as?, options }`. |
| `success` | — | `{ type: all-pass }` | See success criteria below. |
| `limits.maxIterations` | — | `5` | Positive integer; the agent-turn budget. |
| `limits.iterationTimeoutMs` | no | — | Per-iteration timeout. |
| `limits.baseline` | — | `false` | `false` \| `true` \| `"strict"` — pre-run vacuity check. |
| `limits.specGuard` | — | `warn` | `off` \| `warn` \| `error` — if the agent edits the spec mid-run. |
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

**`command`** — run a CLI, judge by exit code; optionally parse a numeric score.
```yaml
- uses: command
  as: tests                 # display name; also how `success.pass` refers to it
  options:
    command: npm test       # the shell command
    cwd: ./sub              # optional; relative to workspace.dir
    expectExitCode: 0       # optional; default 0
    scoreRegex: "coverage: ([0-9.]+)"   # optional; capture group → score
```

**`experiment`** — read a numeric metric and compare to a threshold/baseline.
```yaml
- uses: experiment
  as: latency
  options:
    metricsFile: metrics.json   # OR command: "node bench.js" that prints JSON
    metric: p95                  # key to read
    direction: decrease          # increase | decrease (what "better" means)
    # threshold or baseline comparison per src/evaluators/experiment.ts
```

## Trust knobs — when to set what

- **`limits.baseline: "strict"`** — use when the checks *should* be RED before any
  work (the normal case for a new requirement). The run fails fast with
  `baseline-vacuous` if they already pass, which means the checks don't test the
  requirement. Leave `false` only when checks side-effect (db migrate/seed) and
  can't be run twice cheaply.
- **`limits.specGuard: "error"`** — set when the spec file lives **inside**
  `workspace.dir` (the agent could edit its own success criteria). Best practice
  is to keep the spec *outside* the target repo and leave `warn`.
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

## Invoking the CLI

From the loop-generator repo root, no build needed:
```bash
npm run loopgen -- <args>      # e.g. npm run loopgen -- lint my.loop.yaml --strict
```
After `npm run build`, the `loopgen` binary is on PATH:
```bash
loopgen <args>
```
