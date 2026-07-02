# Proposal: recursive self-improvement loops

**Status:** exploring · **Roadmap:** Tier 2, item 10 · **Depends on:** existing
library mode, batch scheduler, trust guards; a native metric evaluator
([roadmap item 9](./ROADMAP.md#9-transcript-persistence--a-native-coverage-evaluator--exploring)).

## Summary

Use loop-generator to improve loop-generator (and, by extension, any harness the
user owns): loops whose job is to strengthen other loops, evaluators, and the
code they grade — then re-run on the same areas so quality compounds. This is not
a new subsystem. It is a **composition of primitives the repo already ships**
(`LoopEngine`, `runBatch`, `generateSpec`/`specToYaml`, the `needs`-ordered
batch scheduler, and the trust guards), plus one governing discipline
(**maker ≠ checker**) and two small tooling deltas.

The differentiator the whole project rests on — *verifiable outcomes, defended
against false positives* — is not incidental to self-improvement. It is the
enabling condition. A loop that edits its own success criteria is Goodhart's law
with a shell: the cheapest path to green is to weaken the measure. Everything
below is organized so that no single loop both edits and is graded by the same
check.

## Motivation

The patterns people reach for once they trust a loop:

- **Meta-loops** — "add an `experiment` evaluator that measures memory usage,
  then update all existing `.loop.yaml` files to include it."
- **Evaluator strengthening** — once the code is better, raise the bar (100%
  coverage, zero warnings, a tighter p95) and run the same loops again.
- **Dynamic batch generation** — after a batch finishes, parse the report,
  generate N new specs for the remaining issues, run a new batch.
- **Dogfooding** — point loops at loop-generator itself, or the user's CI/CD and
  test framework, and let them recursively improve the improvement engine.
- **Hierarchical / nightly** — a top loop scans the codebase, emits a
  `.batch.yaml`, runs it, reviews the report, and repeats on a schedule.

Three of these already exist as worked examples
(`examples/patterns/evaluator-optimizer.loop.yaml`,
`examples/patterns/ralph-loop.loop.yaml`,
`examples/patterns/osmani-harness.batch.yaml`). The gap is not capability; it is
(a) a documented, guard-aware pattern for pointing loops at their own
definitions, and (b) two primitives that are currently hand-rolled.

## The governing principle: maker ≠ checker

When a loop can reach the thing that grades it, "all checks passed" stops meaning
"the work is done" and starts meaning "the agent found the shortest edit to
green." loop-generator already has the mechanical defenses —
`limits.baseline: strict`, `limits.specGuard`, `limits.evaluatorGuard`,
per-iteration change detection, and the `maxCostUsd`/`maxTokens` ceiling — but
they only hold if the *architecture* keeps the editor and the grader apart.

`osmani-harness.batch.yaml` is this discipline already expressed as a batch:
`discover → implement → verify`, chained by `needs`, sharing one workspace that
the scheduler auto-serializes. The verify stage is a separate pass from the
implement stage. Reuse that shape for every self-improving loop:

- **Loop A (maker)** strengthens evaluator or code X. It is graded by the
  *existing* suite — `npm run typecheck && npm test && loopgen lint <edited
  specs>` — never by X itself.
- A human or CI **blesses** the new X (a normal PR review / merge gate).
- **Loop B (checker)** then runs the now-stricter X against the target code.

The rule in one line: **a loop must never be graded by the measure it edits.**

### The evaluatorGuard tension, resolved

A meta-loop that "improves evaluators" is, by construction, editing success
criteria — exactly what `evaluatorGuard: error` treats as `evaluator-tampered`.
The resolution is *not* to disable the guard. It is to notice that the two files
are different:

- The meta-loop edits `*.loop.yaml` specs and evaluator plug-in source under
  `src/evaluators/`. Its **own** success is measured by the loop-generator test
  suite and `loopgen lint`. Those graders are not the files being edited, so
  `evaluatorGuard: error` and `specGuard: error` stay **on** and protect the
  meta-loop's real contract.
- The spec being edited to *add* an evaluator is caught differently: give the
  meta-loop a `command` checker that parses each target spec and exits nonzero
  when the required evaluator is absent, and set `baseline: strict`. That forces
  the check RED before the agent starts (the specs genuinely lack it yet) — the
  single most important guard here, because a spec-editing loop is the *easiest*
  kind to report a hollow green.

### Recommended guard posture for self-modifying loops

| Loop kind | `baseline` | `specGuard` | `evaluatorGuard` | Budget |
|---|---|---|---|---|
| Meta-loop editing specs/evaluators | `strict` | `error` | `error` | `maxCostUsd` set |
| Evaluator-strengthening (ratchet) | `strict` | `error` | `error` | `maxCostUsd` set |
| Dynamic-batch children | `strict` | `error` | `warn`→`error` | inherited via `defaults` |
| Nightly hierarchical outer loop | n/a (orchestrator) | n/a | n/a | per-item ceilings |

`strict` everywhere it applies: the whole premise of self-improvement is that
the checker verifies the *new* behavior, so a checker that is green before any
work is, by definition, not checking.

## What already exists (the honest baseline)

- **Library mode** — the full engine and batch runner are exported from the
  barrel: `LoopEngine`, `runBatch`, `parseBatchManifest`, `generateSpec`,
  `specToYaml`, `createDefaultRegistries`, and the `BatchReport` / `LoopReport`
  types (`src/index.ts`). A dynamic-batch orchestrator is a *script over these*,
  not new engine code.
- **`LoopReport.outcome`** is the canonical branch key for "what do I do next":
  `success | max-iterations | preflight-failed | aborted | error |
  baseline-vacuous | spec-tampered | evaluator-tampered | budget-exceeded`. A
  dynamic generator dispatches on this.
- **The maker/checker batch shape** — `osmani-harness.batch.yaml`, with `needs`
  ordering and same-workspace serialization for free.
- **The evaluator-optimizer shape** — `evaluator-optimizer.loop.yaml`, combining
  correctness (`command`) with a numeric bar (`experiment`) under
  `baseline: strict`.
- **The trust guards and budget ceiling** — all of `baseline`, `specGuard`,
  `evaluatorGuard`, change detection, `maxCostUsd`/`maxTokens`.
- **The authoring/debugging discipline** — the `author-loop` skill (prove
  lint-clean + starts RED) and `debug-loop` skill (classify by `outcome`).

## The real delta

1. **A meta-orchestrator recipe (docs + a reference script).** A worked,
   copy-pasteable library-mode example: `runBatch` → read `BatchReport` →
   `.filter` items by `outcome` → `generateSpec(...)` + `specToYaml(...)` →
   `runBatch` the follow-up manifest. This is the "dynamic batch generation"
   pattern; today a user would have to assemble it from the exports unaided.
   Ship it under `examples/patterns/` with the same trust-guard commentary the
   other pattern specs carry.

2. **Native metric evaluators (memory, coverage).** The motivating example
   ("measure memory usage") and the ratchet examples ("100% coverage") both
   currently require hand-rolling `experiment` (`scoreRegex` + threshold). This
   is [roadmap item 9](./ROADMAP.md#9-transcript-persistence--a-native-coverage-evaluator--exploring)
   and the strongest single unlock for pattern #2 — a first-class evaluator plus
   a documented custom-evaluator recipe so users can add their own metric without
   touching core.

3. **A "self-improvement" guard preset + docs.** Encode the posture table above
   as the recommended default when a spec's `workspace.dir` overlaps the repo
   that owns the spec (a self-modifying loop). Could start as pure documentation
   (a `docs/` section + this proposal) and later graduate to a `loopgen lint`
   advisory: "this loop edits files under its own workspace — did you mean
   `baseline: strict` and `evaluatorGuard: error`?"

Everything else (scheduling the nightly outer loop) is external — a cron / cloud
agent wrapping the orchestrator script — and does not belong in core.

## Phased plan

- **Phase 0 — the seed (validates the discipline).** One honest meta-loop that
  adds a memory-usage `experiment` evaluator to the repo, graded by the test
  suite + an "is it wired into `index.ts`/`registry.ts`" `command` check, under
  `baseline: strict` + `evaluatorGuard: error`. Authored via the `author-loop`
  skill so it is proven lint-clean and starting RED before anyone trusts it.
  Deliverable: a spec + a green run reviewed by hand. No new core code.

- **Phase 1 — the ratchet.** Land the native metric evaluator (item 2), then a
  strengthening loop that raises a threshold and re-runs on the same area — run
  as Loop B *after* Phase 0's evaluator is blessed. Deliverable: a
  before/after showing the bar moved and the code followed.

- **Phase 2 — dynamic batch generation.** Ship the meta-orchestrator recipe
  (item 1) as a reference script + pattern doc. Deliverable: a run that takes a
  `BatchReport` with `max-iterations` items and emits + runs a follow-up batch.

- **Phase 3 — the nightly hierarchy.** Wrap Phase 2's orchestrator in a scheduled
  agent (external). Deliverable: a documented cron/cloud recipe and the guard
  preset (item 3) so unattended runs default to the safe posture.

## Risks & non-goals

- **Goodhart / self-grading.** The central risk; the maker ≠ checker discipline
  and the guard posture are the mitigation, not a cure. A loop graded by a
  measure it can edit is out of scope by design.
- **Non-convergence and cost.** Recursion multiplies spend and can loop on a bar
  it never clears. `maxCostUsd`/`maxTokens` per item and `maxIterations` are
  mandatory for unattended use; the nightly hierarchy must set them via batch
  `defaults`.
- **Mis-specified checks compound.** A bad check in a seed loop propagates into
  every spec a meta-loop generates. This is the existing "checks are the
  contract" caveat, amplified — which is why Phase 0 requires a hand-reviewed
  green before anything downstream trusts it.
- **Not a general AGI/self-modifying-agent play.** The scope is bounded,
  human-blessed, guard-defended improvement of verifiable artifacts (evaluators,
  specs, tests, measured code) — not open-ended self-rewriting.

## Open questions

- Should the guard preset (item 3) ship as lint advice, a `generate` flag, or
  just docs? Leaning docs-first; graduate on demand.
- Which metric evaluators are worth making native beyond coverage and memory
  (bundle size, warning count, benchmark time)? Let the custom-evaluator recipe
  prove demand before bloating the core, consistent with the roadmap's stance on
  item 9 and the deferred AST/log evaluators.
