# CI/CD + self-improvement plan

Decisions locked in: GitHub releases only (no npm yet) · release-please for
version bumps · nightly canary (~$2 cap) + weekly self-improvement (~$10 cap).

Current state: `pages.yml` is the only workflow — no CI runs tests today. The
repo already has everything a pipeline needs to *grade* itself: typecheck,
vitest with coverage gates (85/80), Stryker mutation gates, the tsup build, the
driver conformance harness, `loopgen lint`, and an offline smoke path
(`mock-demo`) that needs no API key. The plan is four pillars, ordered by
rollout.

## Pillar 1 — CI on every PR (`ci.yml`)

All offline, no secrets, so it can safely run on fork PRs.

| Job | Command | Notes |
|-----|---------|-------|
| typecheck | `npm run typecheck` | strict tsc |
| test + coverage | `npm run coverage` | vitest enforces the 85/80 gates itself |
| build + smoke | `npm run build`, then `node dist/cli/index.js run examples/building-blocks/mock-demo.loop.yaml` | proves the *built* binary runs a real loop offline |
| conformance | `node dist/cli/index.js verify-driver mock` | the driver behavioral contract |
| spec lint | `node dist/cli/index.js lint <each example spec + batch manifest>` | error-severity only: the examples' `./target` scaffolds are created on demand by `init-target`, so `--strict` would fail on the expected `SPEC-WORKDIR-MISSING` warning |

Details: Node 20 + 22 matrix on the test job (engines is `>=20`), npm cache,
`concurrency: cancel-in-progress` per ref. Build, smoke, conformance, and spec
lint run as **one job** (`build-smoke`) since they share the build — branch
protection requires it as a single check by design. **Mutation testing is too slow for
PRs** — run `npm run mutation` in a separate nightly job on master (and allow
`workflow_dispatch`); it still gates via Stryker's thresholds, just
asynchronously.

Branch protection on master: require typecheck, test, build+smoke, conformance,
spec lint. Add the CI badge to the README once green.

## Pillar 2 — Version bumps + GitHub releases

**release-please** (`release-please.yml`, on push to master):

- Reads conventional commits, maintains a rolling Release PR that bumps
  `package.json` and writes `CHANGELOG.md`. Merging that PR creates the
  `vX.Y.Z` tag and the GitHub release. Zero per-PR overhead.
- Config lives in `release-please-config.json` + `.release-please-manifest.json`
  (required for these options): `prerelease: true` until the API is stable,
  0.x bump rules (`bump-minor-pre-major`, `bump-patch-for-minor-pre-major`),
  clean `vX.Y.Z` tags.

**Release artifacts** are built in the *same* workflow, gated on
`release_created` — releases created with `GITHUB_TOKEN` don't trigger other
workflows, so a separate `on: release` job would never fire. The gated steps
check out the release tag, re-run typecheck + tests, build, `npm pack`, and
attach the tarball. Installable via
`npm i https://github.com/ShortStackEngineer/loop-generator/releases/download/vX.Y.Z/loop-generator-X.Y.Z.tgz`.
When you later want npm proper, add one `npm publish --provenance` step and an
`NPM_TOKEN` secret — nothing else changes.

Two atomicity/token caveats, handled: releases are created as **drafts**
(config `draft: true`) and flipped public only after tests pass and the
tarball is attached, so a failed step can't leave a public release without
artifacts (checkout uses the `sha` output — a draft's tag doesn't exist yet).
And because `GITHUB_TOKEN`-created PRs don't trigger CI, the Release PR itself
won't show checks; the release workflow compensates by re-running typecheck +
tests on the exact release commit before publishing. If you later want CI
directly on Release PRs, give release-please a PAT or GitHub App token.

**Commit hygiene:** history is mostly conventional (`fix:`, `chore:`,
`docs:`) but merge commits aren't. Two cheap fixes: switch the repo to
**squash-merge only** (PR title becomes the commit), and add
`amannn/action-semantic-pull-request` so PR titles are lint-enforced. That
makes release-please's changelog trustworthy without policing every commit.

## Pillar 3 — Nightly canary (`canary.yml`)

Offline CI can never catch driver/SDK drift — the Claude Agent SDK is an
`optionalDependency` and the real API's behavior changes underneath it. The
canary is one small **real** run, nightly + `workflow_dispatch`, using the
project's own audit posture as the pass/fail:

- A dedicated `ci/canary.loop.yaml`: tiny task (the fizzbuzz-style RED target
  via `init-target`), `driver: claude-agent-sdk`, `baseline: strict`,
  `specGuard: error`, `evaluatorGuard: error`, `maxIterations: 3`,
  **`maxCostUsd: 2`**.
- Grade the run by its own philosophy: the job fails unless
  `outcome === "success"` **and** `report.warnings` is empty — a warning on a
  green run is a finding. One small script parses `--report report.json`.
- Upload `--report` + `--trace` JSONL as workflow artifacts; on scheduled
  failure, open/update a "canary failing" issue carrying the outcome and
  warning list from the report.
- The scaffold gets an explicit nested `git init` + initial commit:
  `init-target` skips it (the dir is inside the checkout's work tree), and
  without a nested repo the engine falls back to content-hash change detection
  whose persistent warning would fail the zero-warning grade every run.
- `ANTHROPIC_API_KEY` as a repo secret; job restricted to `schedule` and
  `workflow_dispatch` (never fork PRs). Worst-case spend: ~$60/mo, typically
  far less — the cap is a ceiling, not a target.

This doubles as marketing honesty: the trust guards run against a live agent
every night, in public.

## Pillar 4 — Weekly self-improvement (`self-improve.yml`)

This operationalizes `docs/proposal-self-improvement-loops.md` in CI, keeping
its one rule intact — **a loop must never be graded by the measure it edits** —
by mapping the proposal's roles onto GitHub primitives:

- **Loop A (maker)** runs in the workflow on a fresh branch. Its graders are
  the *existing* gates: `npm run typecheck && npm test && loopgen lint` — never
  the artifact it's improving. Guard posture per the proposal: `baseline:
  strict`, `specGuard: error`, `evaluatorGuard: error`, budgets via batch
  `defaults` (**batch total ≤ $10**).
- **Blessing = the PR gate.** The workflow never pushes to master. It opens a
  PR labeled `self-improvement` with the `LoopReport`, warnings, and trace
  attached; Pillar 1's CI grades it like any human PR; you review and merge.
- **Loop B (checker/ratchet)** only ever runs against *blessed* (merged)
  measures — naturally enforced because next week's run starts from master.

Weekly targets, in rollout order (each is RED-able against existing gates):

1. **Mutation-score ratchet** — you just did this by hand (commits `320d891` →
   `f51e5f6`): improve surviving-mutant tests, then raise the Stryker
   thresholds to lock the gain. Perfectly maker≠checker: graded by
   `npm run mutation` with the *new* threshold, which starts RED.
2. **Coverage ratchet** — same shape against the vitest gates.
3. **Task-type deepening** — the README's own Status section says task types
   beyond `function` need deepening; checks are the existing suite plus a
   spec-parse check that the scaffolding exists.
4. **Dynamic follow-up batches** (proposal Phase 2) — the orchestrator script
   reads the `BatchReport`, dispatches on `outcome`, and generates follow-up
   specs for `max-iterations` items.

Mechanics: a library-mode orchestrator at `scripts/self-improve/` (`runBatch` →
read `BatchReport` → open PR), which doubles as the proposal's item-1 reference
recipe under `examples/patterns/`. Loop specs live in `ci/loops/`, *outside*
any `workspace.dir` they point at, so `specGuard: error` has teeth.
`concurrency: group self-improve` so runs never overlap. If the week's loop
ends `budget-exceeded` or tampered, the workflow files the report as an issue
instead of a PR — a failed audit is a result, not an error.

## Rollout order

1. **`ci.yml`** — pure offline, land it first; add branch protection + badge.
2. **release-please + `release.yml`** + squash-merge + PR-title lint. First
   release PR will propose 0.2.0 from the accumulated history.
3. **`canary.yml`** — needs the `ANTHROPIC_API_KEY` secret; start
   `workflow_dispatch`-only for a few manual runs, then enable the schedule.
4. **`self-improve.yml`** — start with the proposal's Phase 0 seed (one
   hand-reviewed green) run manually, then enable weekly with the
   mutation-score ratchet as the first unattended target.

Total unattended spend ceiling: ≈ $100/mo worst case (30 × $2 + 4 × $10);
realistic spend well under half that, since caps only bind on non-convergence.
