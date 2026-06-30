# In depth: linting and trustworthy results

The README summarizes these; this is the full detail. Two related ideas:
`loopgen lint` catches a bad spec *before* any agent runs, and the engine's trust
guards keep a finished run from reporting a false "all checks passed."

## Linting before you run

A misconfigured spec can burn hours before failing for a reason that had nothing
to do with the agent. `loopgen lint` catches those statically, in milliseconds,
before any agent turn:

```bash
loopgen lint my-feature.loop.yaml
loopgen lint punch-list.batch.yaml      # lints the manifest + every item's spec
loopgen lint my.loop.yaml --strict      # exit non-zero on warnings too
loopgen lint my.loop.yaml --json        # machine-readable findings
```

It flags, among other things:

- `SPEC-WORKDIR-NOT-PROJECT` *(error)*: the resolved workspace isn't a git
  repo and has no markers for the declared stack, yet the spec expects an
  existing project. This catches a `workspace.dir` and a batch `base` that both
  go relative and compound (for example, `../..` applied twice, landing in
  `$HOME`).
- `SPEC-EVAL-BINARY-MISSING` / `SPEC-EVAL-FILE-MISSING`: a check's binary or
  referenced script doesn't exist where it will run.
- `SPEC-EVAL-DESTRUCTIVE-ENV`: a check mutates a database without a test env,
  so it would alter your dev data every iteration.
- `SPEC-EVAL-SHARED-RESOURCE`: multiple stateful checks set to run in
  parallel (`evaluation.concurrency > 1`) can race on a shared database.
  Evaluators run sequentially by default, so this only fires when you opt in.
- `SPEC-SMOKE-SELF-FULFILLING`: a smoke that creates records but never drives
  a real endpoint may pass without exercising the feature.
- Batch rules: `BATCH-MAXITER-OVERRIDE`, `BATCH-NEEDS-AS-ORDERING`,
  `BATCH-FAILFAST-CHAIN`.

Exit codes: `2` if any errors, `1` if `--strict` and warnings, else `0`. The
error-severity workspace checks also run automatically as part of every `run`
(the resolved workspace is printed up front); skip with `--skip-preflight`.

## Trustworthy results

"All checks passed" is only meaningful if the checks actually exercise the new
requirement and the agent actually did something. The runner guards against
false positives:

- **Change detection (git):** every iteration is diffed (non-destructively, via
  a throwaway index). The report shows a `git diff --stat`, and a green run that
  changed no files is flagged as likely vacuous. Build and runtime artifacts
  (logs, databases, compile caches, generated assets) are excluded so that
  merely running the test suite can't masquerade as "the agent did work"; add
  your own globs with `workspace.ignore`. It falls back to driver-reported files
  when the workspace isn't a git repo (or is git-ignored).
- **Baseline evaluation** (`limits.baseline: true`, or `--baseline`): runs the
  checks once *before* any agent work. If they already pass, your checks probably
  don't test the requirement, so this is surfaced as a warning. It's off by
  default because side-effecting checks (db migrate/seed) would run twice. Set
  `limits.baseline: "strict"` (or `--strict-baseline`) to make that a hard
  failure (`baseline-vacuous`) instead of a warning, on the principle that a
  check that's green before any work isn't verifying anything. It's
  stack-agnostic: it just runs whatever evaluators you defined on the pre-agent
  workspace.
- **Sequential evaluators (default):** evaluators run one at a time
  (`evaluation.concurrency: 1`) so checks that share external state (several
  `bin/rails` checks against one SQLite database, say) can't race and deadlock
  into false failures. Raise `evaluation.concurrency` only for genuinely
  independent checks that are safe to run in parallel.
- **Spec-integrity guard** (`limits.specGuard`): if the loop spec lives inside the
  workspace, the agent can edit its own success criteria. The runner watches the
  spec file, excludes it from the work diff (so a spec-only edit can't fake
  "work"), and by default (`warn`) raises a warning if the agent modified it. Set
  `specGuard: "error"` to fail the run (`spec-tampered`) so an altered contract
  can't report green; `"off"` disables the watch. (Best practice: keep specs
  outside the target repo.)
- **Evaluator-integrity guard** (`limits.evaluatorGuard`): the real success
  criteria for a `command` check are the test files it runs, and the agent could
  fake a green by editing them. The runner watches those files — auto-detected
  from the command (e.g. `bin/rails test test/foo_test.rb`), plus any
  `evaluators[].guard` paths — excludes them from the work diff, and by default
  (`warn`) raises a warning if any changed. Set `evaluatorGuard: "error"` to fail
  the run (`evaluator-tampered`); `"off"` disables it. A bare runner with no file
  arguments (`npm test`) names nothing and is intentionally not watched.
- **Honest agent outcomes:** drivers report a `stopReason`
  (`completed | max_turns | aborted | error`). When the agent runs out of turns
  or errors but the checks pass anyway, the run still succeeds (checks are the
  source of truth), but the report says so instead of showing a clean green.

All caveats are collected in `report.warnings` and printed under `⚠ warnings:`.
Drivers that report a session id can also resume after a `max_turns` stop
(opt-in: `driver.options.resume: true`).
