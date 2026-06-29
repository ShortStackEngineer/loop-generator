---
name: debug-loop
description: >-
  Diagnose a loopgen run that failed, stalled, errored, or came back green but
  suspicious, and propose the concrete spec/workspace fix. Reads the run report
  (terminal output or --report JSON), classifies by outcome
  (max-iterations / preflight-failed / error / baseline-vacuous / spec-tampered /
  aborted / vacuous-success), reproduces the failing check without spending agent
  budget, and maps it to a fix. Use when a loop fails, hits max iterations, won't
  pass, exhausts its budget, errors out, or "passed but didn't really do
  anything," or when asked why a .loop.yaml run failed.
---

# debug-loop

When a loop run goes wrong, the failure is almost always in the *spec or the
workspace*, not the agent. The engine already names the failure precisely (the
`outcome` field) and attaches honest warnings — even to green runs. This skill
turns that vocabulary into a diagnosis and a concrete fix, confirming the root
cause *without re-spending agent budget* wherever possible.

Field names, the full outcome/warning tables, and the preflight→fix mapping live
in `reference.md`. CLI is `npm run loopgen -- <args>` (or `loopgen <args>` after
build).

## The mindset

- **The checks are the contract.** A run "passes" only if its checks actually
  exercise the requirement *and* the agent did work. So a `success` outcome with
  warnings is a finding, not a pass — treat it as suspect.
- **Reproduce cheaply.** Most root causes (wrong test command, missing binary,
  vacuous check, bad workdir) are confirmable with `lint` + running the check by
  hand — zero agent turns. Do that before any re-run.
- **Don't re-run blindly.** A full `loopgen run` spends real budget and needs
  credentials. Earn the re-run with static + manual evidence first.

## Workflow

### 1. Gather the evidence

Get the most detailed signal available (see `reference.md` → "Getting the
evidence"):

- Best: the **`--report <file>` JSON** — full per-iteration detail. Ask if one
  exists.
- Otherwise: the **terminal output** of the run. The lines that matter are
  `outcome: …`, the `baseline:` line, each `iter N:` line, and the trailing
  `⚠ warnings:` block.
- If there's no report and the failure is *cheap* to reproduce (preflight,
  `error`, `baseline-vacuous` — none invoke the agent), re-run with `--report`.
  If it's a `max-iterations` failure, prefer reading what you have over paying
  the budget again.

Also note the **resolved workspace** the engine printed (`workspace: <path>`) —
several failures are just a wrong path.

### 2. Classify by `outcome`

The `outcome` field is the spine. Match it against the table in `reference.md`
("`outcome` → meaning → likely cause → fix"). Summary:

- `preflight-failed` → environment/config, before any agent work. Read the
  bulleted `reason`; map each to the preflight→fix table.
- `error` → the engine couldn't run: usually a typo in `driver.uses` or an
  evaluator `uses` (check `loopgen list`), or a task `validate()` message.
- `baseline-vacuous` → the checks were green before the agent ran; they don't
  test the requirement. (Hand off to the `author-loop` "RED for the right
  reason" contract to repair the check.)
- `spec-tampered` → the agent edited its own spec; move the spec out of the
  workspace.
- `aborted` → Ctrl-C or `iterationTimeoutMs` too low.
- `max-iterations` → the real debugging case; go to step 3.
- `success` **with warnings** → possible false positive; go to step 4.

### 3. Drill into a `max-iterations` failure

Open the **last** iteration and read three things (table in `reference.md`,
"Splitting a max-iterations failure"):

1. **Which evaluator never passed**, and its `feedback`/`error`. That's the check
   that blocked the loop.
2. **The agent's `stopReason`**: `completed` (it gave up satisfied → the *check
   or requirement* is wrong), `max_turns` (out of budget → raise `maxTurns` /
   set `resume: true`), `error`/`ok: false` (backend/credential failure → fix the
   environment, read `agent.error`).
3. **`changed`/`changedFiles`**: did the agent actually edit anything? If it
   changed files but the wrong check fails, it may be regressing one thing to fix
   another — tighten `requirements`.

### 4. Investigate a suspicious success

If `success: true` but `warnings[]` is non-empty, do not declare victory. Match
each warning in `reference.md` ("Warning glossary"). The two that matter most:

- *"changed no files"* — the loop went green on an untouched workspace. The
  checks are almost certainly vacuous. Confirm by running the check by hand on a
  clean checkout (step 5); it should **fail** before any work.
- *"agent did not complete"* — the green rests entirely on the checks while the
  agent ran out of turns or errored. Verify the checks are actually sufficient.

### 5. Reproduce the root cause (no agent budget)

Confirm the diagnosis with cheap, deterministic signals:

```bash
# static config the run may have only warned on:
npm run loopgen -- lint <spec> --strict

# the actual failure of a check, in the resolved workspace:
cd <resolved workspace> && <the evaluator's command>   # read exit code + output
```

This is what separates a guess from a diagnosis. A missing binary, a wrong cwd,
a flaky test, or a check that passes on untouched code all show up here in
seconds.

### 6. Propose the fix, then re-verify

Map the root cause to a concrete edit (full mapping in `reference.md`):

| Root cause | Fix |
|------------|-----|
| Wrong / placeholder test command | Set the repo's real command in the evaluator `options.command`. |
| Binary missing / wrong cwd | Install it, or fix `options.command` / `options.cwd`. |
| Workdir wrong (`SPEC-WORKDIR-NOT-PROJECT`) | Fix `workspace.dir` (watch compounded relative paths). |
| Check passes before work (vacuous) | Make the check RED until the requirement is met (see `author-loop`). |
| Agent out of turns | Raise `driver.options.maxTurns`; set `resume: true`. |
| Credential / backend error | Set `ANTHROPIC_API_KEY` / `XAI_API_KEY` (or driver login); not a spec bug. |
| Spec tampering | Move the spec outside `workspace.dir`; keep `specGuard: error`. |
| Green-no-diff from artifacts | Add the artifact globs to `workspace.ignore`. |

Then re-verify in the same cheap order: **re-lint → re-run the check by hand →**
only then a full `loopgen run --strict-baseline --report run.json`. Tell the
developer the re-run costs budget and needs credentials; don't launch it
unprompted.

## Guardrails

- **Diagnose from evidence, not vibes.** If you haven't read a failing check's
  output, you haven't found the cause yet.
- **Distinguish backend failures from spec bugs.** `agent.ok === false` /
  `stopReason: error` is an environment problem; don't "fix" the spec for it.
- **A warning on a green run is a finding.** Surface it; don't report the run as
  clean.
- **Prefer the cheapest reproduction.** Lint and a manual check command beat a
  budget-spending re-run every time.
