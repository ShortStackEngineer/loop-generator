# Debugging a run

When a loop run goes wrong — it fails, stalls at the iteration budget, errors
out, or comes back green but suspicious — the fault is almost always in the
**spec or the workspace**, not the agent. The engine already names the failure
precisely (the `outcome` field) and attaches honest warnings even to green runs.
This page turns that vocabulary into a diagnosis and a concrete fix, confirming
the root cause **without re-spending agent budget** wherever possible.

(If you use Claude Code, the `debug-loop` skill runs this diagnosis for you.)

## The mindset

- **The checks are the contract.** A run "passes" only if its checks actually
  exercise the requirement *and* the agent did work. A `success` outcome that
  carries warnings is a finding, not a pass — treat it as suspect.
- **Reproduce cheaply.** Most root causes (a wrong test command, a missing
  binary, a vacuous check, a bad working directory) are confirmable with
  `loopgen lint` plus running the check by hand — zero agent turns. Do that
  before any re-run.
- **Don't re-run blindly.** A full `loopgen run` spends real budget and needs
  credentials. Earn the re-run with static and manual evidence first.

## 1. Gather the evidence

Get the most detailed signal available:

- **Best: the `--report <file>` JSON.** If the run was launched with
  `--report run.json`, read that file — it has every iteration, each evaluator's
  `feedback`/`error`, the agent's `stopReason`/`summary`/`error`,
  `changedFiles`, the diff stat, and the run-level `warnings`.
- **Otherwise: the terminal output.** The lines that matter are
  `outcome: <outcome> — <reason>`, the `baseline:` line, each `iter N:` line,
  and the trailing `⚠ warnings:` block (which prints even on success).
- If there's no report and the failure is **cheap to reproduce** — a preflight
  failure, an `error`, or a `baseline-vacuous`, none of which invoke the agent —
  re-run with `--report`. If it's a `max-iterations` failure, prefer reading
  what you already have over paying the budget again.

Also note the **resolved workspace** the engine printed (`workspace: <path>`):
several failures are simply a wrong path.

## 2. Classify by outcome

The `outcome` field is the spine of the diagnosis. Match it against this table:

| `outcome` | Means | Likely cause | Where to go |
|-----------|-------|--------------|-------------|
| `success` *(no warnings)* | Criteria met, work detected, agent completed | — | Trustworthy green; nothing to do. |
| `success` *(with warnings)* | Criteria met **but** a guard fired — possible false positive | Green-no-diff, or green while the agent didn't finish | Step 4. |
| `max-iterations` | Budget exhausted without satisfying the criteria | A check never went green | Step 3. |
| `preflight-failed` | A pre-run check failed before any agent work | Bad workdir, missing binary, driver not ready | Read the `reason` bullets; map to the [preflight fixes](#preflight-failures). |
| `error` | The engine couldn't run at all | Typo in `driver.uses` or an evaluator's `uses`; a task `validate()` message | Fix the `uses` name (`loopgen list` shows valid ones), or the validation message. |
| `baseline-vacuous` | Checks already passed before the agent ran (strict baseline) | The checks don't test the requirement | Repair the check so it's RED until the requirement is met — see [Authoring loops](./authoring-loops.md). |
| `spec-tampered` | The agent edited its own spec mid-run (`specGuard: error`) | The spec lives inside `workspace.dir` | Move the spec outside the target repo; re-verify the on-disk spec. |
| `evaluator-tampered` | The agent edited a test file a check runs (`evaluatorGuard: error`) | The agent faked a green by weakening the checks | Restore the test files; keep them outside the agent's remit or under `evaluatorGuard: error`. |
| `aborted` | Cancelled (Ctrl-C) or a per-iteration timeout | Manual interrupt, or `limits.iterationTimeoutMs` set too low | Raise/remove the timeout; otherwise expected. |

## 3. Drill into a max-iterations failure

This is the real debugging case. Open the **last** iteration and read three
things:

1. **Which evaluator never passed**, and its `feedback`/`error`. That's the
   check that blocked the loop.
2. **The agent's `stopReason`:**
   - `completed` — the agent decided it was done, but a check still fails. The
     *check or the requirement* is wrong, not the budget. Run the check by hand
     (step 5); fix the command, loosen the criterion, or sharpen `requirements`.
   - `max_turns` — the agent ran out of turns before finishing. Raise
     `driver.options.maxTurns`, and set `driver.options.resume: true` so it
     continues the same session.
   - `error` (with `agent.error` set) — a backend or credential failure, not a
     code problem. Read `agent.error` and fix the environment.
3. **Did the agent change files?** If `changed`/`changedFiles` shows edits but
   the *wrong* check fails, the agent may be regressing one thing to fix another
   — tighten `requirements` ("don't break X").

A check that fails every iteration with a "command not found" / exit 127 is a
wrong bare command or a wrong working directory. Lint and preflight only catch
*project-local* binary paths (`./script.sh`, `bin/foo`), not bare PATH commands
like `npm` or a typo'd tool — so those slip through to runtime. Confirm by hand
in step 5.

## 4. Investigate a suspicious success

If `success: true` but `warnings[]` is non-empty, do not declare victory. The
two warnings that matter most:

- **"changed no files"** — the loop went green on an untouched workspace, so the
  checks are almost certainly vacuous (merely running the suite counts as
  nothing). Confirm by running the check by hand on a clean checkout (step 5); it
  should **fail** before any work. If generated artifacts masked a real diff, add
  their globs to `workspace.ignore`.
- **"the agent did not complete"** — the green rests entirely on the checks while
  the agent ran out of turns or errored. Verify the checks are actually
  sufficient; consider raising `maxTurns`.

## 5. Reproduce the root cause (no agent budget)

Confirm the diagnosis with cheap, deterministic signals. This is what separates a
guess from a diagnosis — a missing binary, a wrong working directory, a flaky
test, or a check that passes on untouched code all show up here in seconds.

```bash
# 1. Static config the run may have only warned on:
loopgen lint <spec> --strict

# 2. The actual failure of a check, in the resolved workspace:
cd <resolved workspace> && <the evaluator's command>   # read the exit code + output
```

## 6. Map the root cause to a fix, then re-verify

| Root cause | Fix |
|------------|-----|
| Wrong / placeholder test command | Set the repo's real command in the evaluator's `options.command`. |
| Binary missing / wrong working directory | Install it, or fix `options.command` / `options.cwd`. |
| Workdir wrong (`SPEC-WORKDIR-NOT-PROJECT`) | Fix `workspace.dir` (watch for compounded relative paths — `../..` applied twice lands in `$HOME`). |
| Check passes before any work (vacuous) | Make the check RED until the requirement is met — see [Authoring loops](./authoring-loops.md). |
| Agent out of turns | Raise `driver.options.maxTurns`; set `resume: true`. |
| Credential / backend error | Set `ANTHROPIC_API_KEY` / `XAI_API_KEY` (or use the driver's login). This is an environment problem, not a spec bug. |
| Spec tampering | Move the spec outside `workspace.dir`; keep `specGuard: error`. |
| Evaluator (test-file) tampering | Restore the test files; keep `evaluatorGuard: error`. |
| Green with no diff from build artifacts | Add the artifact globs to `workspace.ignore`. |

Then re-verify in the same cheap order — **re-lint → re-run the check by hand →**
and only then a full run:

```bash
loopgen run <spec> --strict-baseline --report run.json
```

That last step costs budget and needs credentials; don't launch it until the
static and manual checks look right.

### Preflight failures

Preflight runs the error-severity workspace checks before any agent turn (the
same rules `loopgen lint` reports). Map each bullet in the `reason` /
`preflight.errors` to its fix:

| Bullet | Fix |
|--------|-----|
| workspace not a git repo / no stack markers (`SPEC-WORKDIR-NOT-PROJECT`) | Fix `workspace.dir`; watch compounded relative paths. |
| project-local binary missing (`SPEC-EVAL-BINARY-MISSING`) | A command whose leading binary is a local path (`./script.sh`, `bin/foo`) doesn't exist. Fix the path/cwd. Bare PATH commands are *not* preflight-checked. |
| referenced script/file missing (`SPEC-EVAL-FILE-MISSING`) | Create the file or fix the path. |
| driver preflight (SDK not installed / API key missing) | Install the optional dependency; set the driver's credentials. |

## Guardrails

- **Diagnose from evidence, not vibes.** If you haven't read a failing check's
  output, you haven't found the cause yet.
- **Distinguish backend failures from spec bugs.** `agent.ok === false` /
  `stopReason: error` is an environment problem; don't "fix" the spec for it.
- **A warning on a green run is a finding.** Surface it; don't report the run as
  clean.
- **Prefer the cheapest reproduction.** Lint and a manual check command beat a
  budget-spending re-run every time.

## Reference

For the full `LoopReport` field map, every `stopReason`, and the complete warning
glossary, see the in-repo `debug-loop` skill's `reference.md`
(`.claude/skills/debug-loop/reference.md`). The source of truth is the code:
`src/core/engine.ts` (outcomes, warnings, report shape), `src/cli/run.ts`
(terminal formatting), and `src/drivers/types.ts` (stop reasons).
