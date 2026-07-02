# Roadmap

This roadmap is derived from an external critic's review of the project plus a
ground-truth audit of the current code. Each item notes *why* it matters and
*what already exists*, so the scope is the real delta — not a restatement of the
review.

The through-line: loop-generator's differentiator is **verifiable outcomes**
(the checks are the spec, backed by layered false-positive defenses). The items
below are ordered to protect and extend that differentiator first, then improve
the loop's feedback quality, usability, and ecosystem.

Status legend: **planned** (agreed, not started) · **exploring** (needs design)
· **deferred** (revisit later).

---

## Tier 1 — near-term, high leverage, low cost

### 1. Deliver a focused diff in the iteration feedback — *planned*

The workspace diff is already computed each iteration (`diffTrees` →
`diff.files` / `diff.stat` at `src/core/engine.ts:427`), but `buildFeedback`
(`src/core/feedback.ts:19`) only receives `evaluations + verdict`. The diff is
stored on `IterationReport` and never reaches the agent.

**Do:** pass the changed-file list (and a truncated, ignore-respecting patch) to
`buildFeedback` so each iteration prompt tells the agent what it changed last
turn. This is mostly plumbing — the data exists at the call site.

**Why:** directly attacks context drift over iterations; the agent stops
re-deriving state it already changed.

### 2. Plug the off-git trust hole — *planned*

When the workspace is not a git repo (or is git-ignored), change detection falls
back to driver-reported `agent.changedFiles` verbatim
(`src/core/engine.ts:430-431`). Two silent gaps:

- The fallback emits only a `log.debug` (`engine.ts:248-254`) — invisible at the
  default log level — and **nothing is added to `report.warnings`**. Relying on
  a self-reported change list is trust-the-driver territory and should be visible
  in the report.
- The vacuous-success guard ("green but changed nothing") is gated on
  `gitEnabled` (`engine.ts:448`), so off-git it **cannot fire at all**, and
  nothing replaces it.

**Do:** always attach a persistent warning to `report.warnings` when a run
relies on driver-reported changes, and make the no-op / vacuous-success signal
work (even if weaker) in fallback mode.

**Why:** this is a silent gap in the project's strongest feature. Cheap fix,
high integrity payoff. (The deeper fix — real change detection without git — is
Tier 2, item 6.)

### 3. `generate --verify` — encode the author-loop contract in the CLI — *planned*

`loopgen generate` today only structurally validates the spec via Zod
(`src/generate.ts:62`); it never lints and never proves the checks start RED.
The generated spec also hard-codes `workspace.snapshot: "none"` and omits
`limits.baseline` (`src/generate.ts:45,58`), so it doesn't default to the safe
posture. The "lint-clean + checks start RED for the right reason" contract
currently lives only in the `author-loop` skill as a manual workflow.

**Do:** add `generate --verify` that runs the linter and a baseline RED check
after scaffolding, and default generated specs to a safer baseline posture.

**Why:** turns the most valuable authoring discipline from tribal knowledge into
a one-command guarantee.

### 4. Document failure modes and surface the skills — *planned*

The README has no "when (not) to use / known limitations" section (confirmed
absent). The three in-repo skills (`author-loop`, `debug-loop`, `add-driver`)
are documented only in `CLAUDE.md` — invisible to human users.

**Do:**
- Add a README (and/or `docs/`) section: *Works best when… / Poor fit for… /
  What this can't do.* Fold in the honest caveats the project already embodies
  (mis-specified checks, metric gaming, context degradation, subjective tasks).
- Promote `author-loop` and `debug-loop` into user-facing workflow docs.

**Why:** the project's credibility comes from honesty about verification limits;
completing that story costs almost nothing and sets correct expectations.

### 5. Cost/usage surfacing + a budget ceiling — *planned*

Per-iteration usage is captured (`AgentRunResult.usage`) but the live CLI line
prints only `turns` and `costUsd` (`src/cli/run.ts:43-53`); token counts appear
only in the aggregate block. There is no cost/token governance.

**Do:** surface per-iteration tokens, and add `limits.maxCostUsd` /
`limits.maxTokens` that stop the loop when the cumulative budget is exceeded.

**Why:** usage is already tracked end-to-end, so a budget stop is cheap, and
real runs are stochastic and expensive — a hard ceiling is table stakes for
unattended use.

---

## Tier 2 — medium-term, needs design

### 6. Filesystem-walk change detection for non-git workspaces — *exploring*

`src/core/workspace.ts` is entirely git-based. An independent mtime/hash
snapshot before and after each iteration would extend real change detection —
and the vacuous-success guard — to workspaces where git is unavailable, instead
of trusting the driver's self-report.

**Why:** the principled version of Tier 1 item 2; removes the weakest link in
the trust story.

### 7. Human-in-the-loop controls — *exploring*

`onIteration` returns `void` (`src/core/engine.ts:85`) so it cannot pause or
abort; the only cancellation path is an external `AbortSignal` that stops *after*
the current iteration. There is no pause/step or "show diff and wait" mode.

**Do:** add a review/step mode (show the diff + evaluations, wait for
continue/abort/edit) and let the iteration hook signal continue vs. abort.

**Why:** the biggest usability gap for higher-stakes or expensive runs.

### 8. Resolve the structured-feedback dead affordance — *exploring*

`FeedbackSummary.evaluations` is passed to `driver.run` via
`invocation.feedback` (`src/drivers/types.ts:28-37,51`), but **no built-in
driver reads it** — every driver consumes only the rendered `feedback.text`
already embedded in the prompt.

**Do:** either wire at least one driver to consume the structured channel (e.g.
hand the agent failing checks / the diff as structured tool input the model can
parse reliably) or remove the field.

**Why:** a dead affordance in a public contract erodes trust in the contract;
resolve it one way or the other.

### 9. Transcript persistence + a native coverage evaluator — *exploring*

- Transcripts persist only when `--report <file>` is passed, and the CLI drivers
  (grok, github-copilot, opencode) store only truncated stdout/stderr tails —
  not full conversations — which undercuts `debug-loop`. Add optional,
  first-class transcript capture.
- Only two evaluators exist (`command`, `experiment`). Coverage thresholds must
  be hand-rolled via `scoreRegex` + `scoreGte`. Ship a native coverage evaluator
  **plus a documented custom-evaluator recipe** — the recipe matters more than
  any single built-in primitive.

**Why:** better observability for diagnosing runs, and a clearer path to
powerful verification without bloating the core.

### 10. Recursive self-improvement loops — *exploring*

Loops whose job is to strengthen other loops, evaluators, and the code they
grade — then re-run on the same areas so quality compounds. Three shapes already
ship as examples (`evaluator-optimizer.loop.yaml`, `ralph-loop.loop.yaml`,
`osmani-harness.batch.yaml`) and library mode already exposes everything a
dynamic-batch orchestrator needs (`LoopEngine`, `runBatch`, `generateSpec` /
`specToYaml`, `BatchReport` / `LoopReport` at `src/index.ts`). So this is
composition + discipline, not a new subsystem.

The governing constraint is **maker ≠ checker**: a loop that edits its own
success criteria is Goodhart's law with a shell, so no loop may be graded by the
measure it edits. The existing guards (`baseline: strict`, `specGuard`,
`evaluatorGuard`, change detection, `maxCostUsd`/`maxTokens`) enforce this once
the architecture keeps editor and grader apart.

**Do:** (1) ship a meta-orchestrator recipe under `examples/patterns/` — a
library-mode script that reads a `BatchReport`, dispatches on `LoopReport.outcome`,
and generates + runs a follow-up batch; (2) land native metric evaluators
(memory, coverage) — this is the strongest unlock and folds into item 9; (3)
document a "self-improvement" guard preset for loops whose workspace overlaps the
repo that owns them, later graduating to a `loopgen lint` advisory.

**Why:** it is the highest-leverage use of the project's own differentiator —
verifiable, false-positive-defended outcomes are the *enabling condition* for
safe self-modification, not incidental to it.

Full design: [Proposal — recursive self-improvement
loops](./proposal-self-improvement-loops.md).

---

## Deferred / not planned

- **AST-query and log/event-assertion evaluators** — speculative and large; the
  `command` evaluator plus the custom-evaluator plugin path already cover most
  cases. Let the documented recipe (item 9) prove demand first.
- **"Replay last iteration with an edited prompt"** — niche; the pause/step
  control (item 7) delivers most of the same value.
- **Full third-party driver ecosystem** (external-package driver loading,
  plugin discovery, a "publish your driver" guide) — the conformance harness is
  already exported (`loop-generator/testing`) and documented for extenders in the
  README "Extending it" section. This is a growth play, not a correctness one;
  revisit after Tier 1–2 land.

---

## What we are explicitly *not* trying to solve

These are fundamental to the agentic-loop approach, not implementation gaps. The
roadmap makes their failure modes *more visible*; it does not eliminate them.

- Mis-specified or insufficient checks (the checks are the contract — bad checks,
  bad contract).
- Agents that game metrics or ship minimal patches that pass surface checks.
- Context degradation over many iterations (items 1 and 7 mitigate; they don't
  cure).
- Tasks whose success is inherently subjective or requires human judgment.
- The underlying unreliability of LLM agents on large, novel refactors.
