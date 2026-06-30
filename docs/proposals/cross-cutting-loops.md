# Proposal: making loop-generator safe for cross-cutting work

**Status:** draft / RFC
**Motivation:** evidence from using loop-generator to build a substantial
application as a sequence of many small loops — one loop per feature, each gated
by a hand-written contract that started RED — followed by a few **cross-cutting**
loops (changes that span features rather than living inside one).

## The observation

Per-feature *vertical* loops worked very well: most converged in a single agent
iteration, and contracts stayed green and untouched. The problems appeared only
when work went **cross-cutting**, and they were the same two failures every time:

1. **A loop can report green while the suite is red.** A cross-cutting change
   (a backend rule touching several features at once) broke tests the loop never
   ran. The loop's regression evaluator enumerated *specific* test files and
   passed — but it did not run other tests in the project (including auxiliary
   tests the agent itself had written), so the loop succeeded while the full
   suite was failing. Only a manual whole-suite run surfaced it.

2. **The agent can edit the checker.** The agent more than once modified files
   that *are* the success criteria — appending to a contract test file, reusing a
   contract's class name — with no objection from the engine, because `specGuard`
   protects the `.loop.yaml`, not the test files the evaluators run.

Both are failures of **verification scope and integrity**, not of the agent or
the model. They generalize to any multi-loop program and motivate two engine
improvements plus one composition pattern.

---

## Improvement 1 — first-class whole-suite verification

### Problem

A `command` evaluator that enumerates specific files (e.g.
`<test-runner> path/to/feature_test`) is a *partial* gate. It is the right thing
for a feature's own RED→GREEN check, but a poor regression gate: anything not in
the list — a sibling feature, the agent's own tests, an unrelated module — can
break invisibly. A loop can be green while the application is broken.

### Design

Two parts, smallest first:

**(a) Lint nudge — `SPEC-EVAL-PARTIAL-REGRESSION` (info/warn).**
When a `command` evaluator's command contains explicit test-file paths (tokens
that resolve to files under the workspace, especially `*_test.*` / `*_spec.*` /
`spec/` / `test/`), emit:

> this check runs specific test files, not the whole suite — regressions outside
> these files (including tests the agent adds) won't be caught. Consider a
> whole-suite gate (a separate `verify`-style evaluator, or drop the file list).

Implementation: a new rule in `src/lint/rules.ts` operating on
`spec.evaluators[].options.command`. Pure static analysis, no new runtime.

**(b) A documented "verify stage" idiom (no engine change).** The whole-suite gate
already exists — it's just a test command with no file arguments, ideally as a
**separate checker loop** (see the harness composition below). The fix for the
regression we hit was literally a final loop whose evaluator runs the entire
suite. Promote this from "thing you can do" to "thing the docs/templates tell you
to do" for any multi-loop program.

> This is the same mechanism the `examples/osmani-harness` **verify** stage
> already uses (full suite + a coverage bar). A program that ends with that stage
> catches cross-cutting regressions automatically.

### Why not "always run the whole suite"?

Because per-feature RED-before requires a *scoped* check (the new feature's tests
fail; the rest already pass). The right shape is **a scoped check to drive the
feature + a whole-suite checker to catch cross-cutting damage** — which is exactly
maker/checker separation. The engine shouldn't force one command; it should make
the partial-gate risk visible (lint) and make the whole-suite checker the obvious
default (docs + the verify-stage pattern).

---

## Improvement 2 — evaluator-integrity guard

### Problem

`specGuard` (`src/core/engine.ts`) hashes the spec file, excludes it from the work
diff, and flags tampering — so the agent can't quietly rewrite its own success
criteria *in the spec*. But the real success criteria for a `command` evaluator
live in the **test files** that command runs, and those are unguarded. The agent
modified contract test files during the build with no signal from the engine; it
was caught only by a manual `git diff` of those files after each run.

### Design

Generalize `specGuard` to the files an evaluator depends on. Add
`limits.evaluatorGuard: off | warn | error` (default `warn`), mirroring
`specGuard`:

1. **Resolve guarded files.** For each `command` evaluator, parse the command for
   tokens that resolve to existing files (or globs/dirs) under `workdir`,
   filtered to test-like paths (`*_test.*`, `*_spec.*`, `spec/`, `test/`). Allow
   an explicit `evaluators[].guard: [globs]` override for non-obvious cases.
2. **Snapshot** their hashes before the run (reusing the `hashFileSafe` approach
   already used for the spec).
3. **After each iteration**, re-hash. If a guarded file changed:
   - `warn`: attach a run warning ("the agent modified a file the `<name>` check
     depends on — the checker may have been altered; re-verify").
   - `error`: fail the run with a new outcome `evaluator-tampered`, sibling to
     `spec-tampered`.
4. **Exclude guarded files from the work diff** (like the spec) so editing the
   checker can never count as "work" for no-op detection.

This is deliberately the same shape as `specGuard` — same hashing, same
warn/error policy, same diff-exclusion — so it's a focused extension, not a new
subsystem. Touch points: `src/core/engine.ts` (watch list + checks),
`src/core/spec.ts` (the `evaluatorGuard` / per-evaluator `guard` schema fields),
`LoopOutcome` (add `evaluator-tampered`), and the run report.

### Interaction with legitimate test edits

Sometimes the agent *should* write tests (TDD-style loops). Two answers: (a) the
guard only watches files an *evaluator command names* — the contract — not all
test files, so agent-authored tests in a separate location are unguarded by
design; and (b) `warn` (the default) surfaces the edit without failing, the right
posture when test edits are expected.

---

## Composition: can a harness *hold* a multi-loop program?

A natural follow-on: take the `examples/osmani-harness` shape (discover →
implement → verify) and make the **implement** phase a whole **batch** of
feature loops. Can the higher-level harness then carry the cross-cutting guidance
that a flat list of per-feature loops lacks?

Short answer: **the harness is the right shape, its `verify` stage already solves
the biggest gap, but it needs one new capability (nested batches) and a clear
split of what "guidance" can and can't be hoisted.**

### 1. Structural feasibility — needs nested batches

The osmani-harness is itself a **batch** (`discover` → `implement` → `verify`,
each a `.loop.yaml`). A batch *item* today points at a **loop** (`spec` →
`.loop.yaml`, or `inline` a `LoopSpec`) — see `batchItemSchema` in
`src/batch/manifest.ts`. There is no "batch item that is a batch," so you can't
literally drop a feature batch inside the `implement` item. Two ways forward:

- **Flatten (works today):** one batch = `discover` → `feature-1 … feature-n` →
  `cross-cutting loops` → `verify`, wired by `needs`. Fully expressible now.
- **Nested batches (proposed feature):** let a batch item reference a
  `.batch.yaml` (`spec: features.batch.yaml`). The runner inlines the child's
  items, namespacing names and rebasing `needs`, so a harness reads
  `discover → [feature batch] → verify`. A natural extension of the scheduler,
  which already does dependency ordering + same-workspace exclusivity. Worth its
  own proposal.

### 2. Which cross-cutting guidance *can* the higher level hold?

| Cross-cutting need | Held by the harness? | Where it lives |
| --- | --- | --- |
| **"Verify the whole suite, not per-feature files"** | **Yes — fully.** | The harness's **`verify` stage** runs the entire suite (+ coverage) as an independent checker — exactly Improvement 1. This catches the green-loop/red-suite regression automatically. The maker/checker split *is* the mechanism. |
| **"Order: cross-cutting loops after the features they touch"** | **Yes.** | `needs` edges in the batch; the harness encodes sequence directly. |
| **"Establish a precondition before a cross-cutting loop runs"** | **Partly.** | The **`discover` stage can *plan* it** (emit a plan that inserts a precondition step), and `needs` can sequence a dedicated step. But the actual edits are *executed* by a loop, not declared by the harness. The higher level holds the *plan and the ordering*; a loop still does the work. |

So the harness can hold the **verification scope** (its whole reason for a verify
stage) and the **ordering/plan** (discover + needs). What it cannot do is reach
into a child loop and silently rewrite its preconditions — those become an
explicit earlier loop or instructions in the target loop's `requirements`. That
is a feature, not a bug: it keeps each loop's contract self-contained.

### 3. A concrete shape

```
program-harness.batch.yaml      (the higher level)
├─ discover   → plan: feature order + cross-cutting rules + any preconditions
├─ build      → (nested) features.batch.yaml     # the per-feature loops
└─ verify     → evaluator: <whole test suite> + coverage bar
                ← the stage that catches cross-cutting regressions the
                  per-feature checks miss
```

With nested batches + Improvement 1's verify stage, this composition self-corrects
the biggest cross-cutting failure mode — a build loop reporting green while
unrelated tests are red — because the `verify` stage runs everything. A
precondition still needs to be *planned by discover* and *executed by a step*, but
the harness carries the discipline.

---

## Suggested order of work

1. **Improvement 2 (evaluator-integrity guard)** — highest safety value, smallest
   surface, directly mirrors `specGuard`.
2. **Improvement 1a (lint nudge)** — cheap; makes the partial-gate trap visible.
3. **Verify-stage docs/template** — promote whole-suite checking as the default
   for multi-loop programs; point at the `osmani-harness` `verify` stage.
4. **Nested batches** — the largest; enables a harness to hold a program-as-batch.
   Warrants its own proposal.
