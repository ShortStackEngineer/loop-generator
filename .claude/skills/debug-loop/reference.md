# debug-loop reference

Lookup tables for triaging a loopgen run: the report shape, every `outcome`
value, the agent stop reasons, and the engine's warning strings (with fixes). The
workflow lives in `SKILL.md`.

Source of truth: `src/core/engine.ts` (outcomes, warnings, report shape),
`src/cli/run.ts` (terminal formatting), `src/drivers/types.ts` (stop reasons),
`src/evaluators/types.ts` (evaluation result). Code wins over this doc.

## Getting the evidence

Two sources, in order of usefulness:

1. **The JSON report** — best. If the run used `--report <file>`, read that file:
   it has every iteration, each evaluator's `feedback`/`error`, the agent
   `stopReason`/`summary`/`error`, `changedFiles`, `diffStat`, and run `warnings`.
   If they don't have one and the failure is cheap to reproduce (preflight,
   baseline-vacuous, error — none spend agent turns), re-run with `--report`.
   Don't blindly re-run a `max-iterations` failure — that spends the budget again.
2. **The terminal output** of `loopgen run` — enough to classify. Key lines:
   - `outcome: <outcome> — <reason>` ← the triage spine.
   - `baseline: checks ALREADY PASS ⚠ (likely vacuous) — …` ← vacuity signal.
   - `iter N: PASS|retry — agent <status> (…) — ✓ tests ✗ typecheck=… · <changed>`
   - per-iter `error:` / `summary:` / `⚠ <warning>` lines.
   - the `⚠ warnings:` block at the end (present even on SUCCESS).

## `LoopReport` field map

| Field | Use in triage |
|-------|---------------|
| `outcome` | The category (table below). Start here. |
| `success` | Boolean. Can be `true` *with* warnings — see "false-positive" rows. |
| `reason` | One-line why. For `error`/`preflight-failed` it carries the detail. |
| `baseline` | `{ satisfied, reason, evaluations }` if a baseline ran. `satisfied: true` = vacuous checks. |
| `iterations[]` | Per-turn detail; the **last** one usually explains a `max-iterations` fail. |
| `iterations[].evaluations[]` | `{ name, passed, score?, feedback?, error? }` — which check failed and why. |
| `iterations[].agent` | `{ ok, stopReason, summary?, error?, usage }` — what the agent did. |
| `iterations[].changed` / `.changedFiles` | `false`/empty on a green run ⇒ vacuous. |
| `warnings[]` | Run-level caveats; **read these even when `success: true`**. |
| `error` | Set when the driver/evaluator threw or a typo failed resolution. |
| `preflight` | Merged preflight `{ ok, errors[], warnings[] }`. |

## `outcome` → meaning → likely cause → fix

| `outcome` | Means | Likely cause | Fix |
|-----------|-------|--------------|-----|
| `success` *(no warnings)* | Criteria met, work detected, agent completed | — | Nothing — trustworthy green. |
| `success` *(with warnings)* | Criteria met **but** a guard fired — possible false positive | Green-no-diff or green-while-incomplete (see warnings glossary) | Treat as suspect: confirm a check actually tests the requirement; don't trust until resolved. |
| `max-iterations` | Budget exhausted without satisfying criteria | A check never went green | Read the **last** iteration's failing evaluator `feedback`. Then split causes below. |
| `preflight-failed` | A pre-run check failed before any agent work | Bad workdir, missing binary, driver not ready | Read `reason` bullets / `preflight.errors`; map via the preflight table below. |
| `error` | Engine couldn't run | Unknown `driver.uses`/evaluator `uses` (typo), task `validate()` failed, or driver threw | Read `reason`/`error`. Fix the `uses` name (`loopgen list`), or the validation message. |
| `baseline-vacuous` | Checks already passed before the agent (strict baseline) | The checks don't test the new requirement | Fix the check so it's RED until the requirement is met. See `author-loop` for the "RED for the right reason" contract. |
| `spec-tampered` | Agent edited the spec mid-run (`specGuard: error`) | Spec lives inside `workspace.dir` | Move the spec outside the target repo; re-verify the on-disk spec. |
| `aborted` | Cancelled (Ctrl-C) or per-iteration timeout | Manual interrupt or `limits.iterationTimeoutMs` too low | Raise/remove the timeout; otherwise expected. |

### Splitting a `max-iterations` failure (read the last iteration)

| What the last iteration shows | Diagnosis | Fix |
|-------------------------------|-----------|-----|
| Same check `✗` every iteration, agent `completed` | The check is wrong/too strict, or the requirement is underspecified | Run the check's command by hand (below). Fix the command, loosen the criterion, or sharpen `requirements`. |
| `agent max_turns` each iteration | Agent ran out of turns before finishing | Raise `driver.options.maxTurns`; set `driver.options.resume: true` so it continues the session. |
| `agent ✗ error` / `agent.error` set | Driver/backend failure (not the code) | Read `agent.error`: missing credentials, network, CLI not installed. Fix the environment, not the spec. |
| Check `error` field set (evaluator threw) | The evaluator command itself is broken | Fix the command/cwd; confirm the binary exists. |
| A check fails every iteration with non-zero exit (e.g. *command not found*, exit 127) | Wrong command — a bare binary not on PATH, or wrong `cwd`. Lint/preflight only catch *project-local* binary paths, not bare commands, so this slips through to runtime | Run the command by hand (step 5); fix `options.command`/`options.cwd` or install the tool. |
| Agent changes files but the *wrong* check fails | A regression in another check | The agent is weakening one thing to fix another; tighten `requirements` ("don't break X"). |

## `agent.stopReason` (per iteration)

| stopReason | Meaning |
|------------|---------|
| `completed` | Agent decided it was done. If checks still fail, the *check or requirement* is the issue, not the budget. |
| `max_turns` | Hit its turn budget — incomplete work, not a crash. Raise `maxTurns` / enable `resume`. |
| `error` | Real backend failure. `ok: false`, see `agent.error`. |
| `aborted` | Cancelled or timed out. |
| `unknown` | Backend didn't report. Treat like `completed` but with less confidence. |

## Warning glossary (engine `warnings[]`) — appear even on SUCCESS

| Warning text (substring to match) | Meaning | Fix |
|------------------------------------|---------|-----|
| `success criteria already pass BEFORE any agent work` | Baseline was green ⇒ checks don't verify the requirement | Make the check RED until the requirement is met (or it's a `baseline-vacuous` fail under strict). |
| `criteria satisfied but the agent changed no files` | Green with zero diff ⇒ checks may be vacuous (just running the suite counts as nothing) | Confirm a check exercises the new behavior; add `workspace.ignore` if generated artifacts masked the diff. |
| `criteria satisfied, but the agent did not complete (max_turns/error)` | Green rests on the checks alone; the agent didn't finish | Verify the checks are sufficient; consider raising `maxTurns`. |
| `the agent modified the loop spec file … during the run` | Spec tampering (warn mode) | Move the spec out of the workspace; under `specGuard: error` this becomes a `spec-tampered` failure. |
| `workspace.snapshot is "git" but … is not a git repo` | Change detection disabled | Init git in the workspace or drop `snapshot: git`; no-op detection falls back to driver-reported files. |

## Preflight failure → fix (mirrors the lint rules)

| Bullet in `reason` / `preflight.errors` | Fix |
|------------------------------------------|-----|
| workspace not a git repo / no stack markers (`SPEC-WORKDIR-NOT-PROJECT`) | Fix `workspace.dir`; watch for compounded relative paths (`../..` twice → `$HOME`). |
| project-local binary missing (`SPEC-EVAL-BINARY-MISSING`) | A command whose leading binary is a **local path** (`./script.sh`, `bin/foo`) doesn't exist. Fix the path/cwd. **Note:** bare PATH commands (`npm`, `pytest`, a typo'd tool) are *not* preflight-checked — a wrong bare command instead fails its check every iteration and surfaces as `max-iterations` (see below). |
| referenced script/file missing (`SPEC-EVAL-FILE-MISSING`) | Create the file or fix the path. |
| driver preflight (SDK not installed / API key missing) | Install the optional dep; set `ANTHROPIC_API_KEY` / `XAI_API_KEY` (or use the driver's login). |

## Reproduce without spending agent budget

```bash
# 1. Static config issues the run may have only warned on:
npm run loopgen -- lint <spec> --strict

# 2. Run a failing check by hand, in the resolved workspace, to see the real error:
cd <workspace.dir> && <the evaluator's command>     # inspect exit code + output

# 3. Only after static + manual checks look right, re-run (this DOES cost budget):
npm run loopgen -- run <spec> --strict-baseline --report run.json
```
