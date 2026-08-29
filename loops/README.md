# loop-generator dog-food library

Reusable loop specs for driving **all** changes to this monorepo through loop-generator.
Specs live **outside** `workspace.dir` (the repo root) so `specGuard` and `evaluatorGuard`
have teeth — the agent edits the code, not the contract.

## Layout

```text
loops/
  README.md                 ← you are here
  new                       ← copy a template → instances/<slug>.loop.yaml
  templates/                ← archetypes (copy, do not run directly)
    bug.loop.yaml
    greenfield.loop.yaml
    refactor.loop.yaml
  invariants/
    regression.loop.yaml    ← full suite; always green before merge
  instances/                ← one concrete spec per ticket (git-tracked)
    <slug>.loop.yaml
```

## Workflow

1. **Classify the work** — bug, greenfield, or refactor.
2. **Frame checks** (`.claude/skills/frame-checks`) — turn the ask into falsifiable
   acceptance checks. If you cannot write a RED behavior check (bug/greenfield), stop
   and sharpen the ask.
3. **Scaffold the instance:**

   ```bash
   ./loops/new bug issue-42-retry-guard
   # or: greenfield | refactor
   ```

4. **Edit** `loops/instances/<slug>.loop.yaml`:
   - Fill in `requirements` (concrete paths, symbols, expected behavior).
   - Set evaluator paths (`repro`, `acceptance`) and `guard:` lists to match real test files.
   - While a new check is **RED**, keep it out of `npm test` so `regression` stays
     green under `baseline: strict`: add the path to `vitest.config.ts` → `test.exclude`
     **and** `vitest.repro.config.ts` → `test.include`, and point the new evaluator at
     `npx vitest run --config vitest.repro.config.ts`. Remove the path from both lists
     once the stub goes green (then `npx vitest run <file>` is enough).
   - Confirm the **new** checks are RED: `npm run loopgen -- lint loops/instances/<slug>.loop.yaml`
     then `npm run loopgen -- run loops/instances/<slug>.loop.yaml --driver mock` only after
     you have a scripted mock path — for real work use the default driver or `-d claude-agent-sdk`.
5. **Prove baseline** (bug/greenfield): run evaluators once with no agent — they must fail
   for the *new* checks while invariants still pass.
6. **Run the loop:**

   ```bash
   npm run loopgen -- run loops/instances/<slug>.loop.yaml
   npm run loopgen -- run loops/instances/<slug>.loop.yaml --trace loops/.loopgen/<slug>.jsonl
   ```

7. **Archive** — keep the instance spec **as-run** (driver, limits, requirements, evaluators)
   and the `LoopReport` as the audit trail. Add a short "COMPLETED" header comment; do not
   rewrite the spec into a green no-op. Promote patterns back into `templates/` only after
   the same archetype worked twice.

## Archetypes

| Kind | When | Baseline | New checks |
| --- | --- | --- | --- |
| **bug** | Fix broken behavior | `strict` | Repro test (RED) + full regression |
| **greenfield** | New feature / module | `strict` | Acceptance tests (RED) + regression |
| **refactor** | Behavior unchanged | `false` | None — existing suite must stay green |

**Refactor** intentionally skips `baseline: strict` because the contract is "don't break
what already passes," not "add a new RED check."

## Invariants

`loops/invariants/regression.loop.yaml` runs `npm run typecheck` and `npm test` against the
repo root. Run it before or after a work loop:

```bash
npm run loopgen -- run loops/invariants/regression.loop.yaml --driver mock
```

For a real unattended run, omit `--driver mock` and use a driver with credentials.

### Batch: invariants then work

Copy this manifest into `loops/batches/<slug>.batch.yaml` and set the work spec path:

```yaml
version: 1
name: invariants-then-work
concurrency: 1
items:
  - name: invariants
    spec: ../invariants/regression.loop.yaml
  - name: work
    spec: ../instances/<your-slug>.loop.yaml
    needs: [invariants]
```

```bash
npm run loopgen -- batch loops/batches/<slug>.batch.yaml
```

## Drivers

Templates default to `claude-agent-sdk`. Override without editing the spec:

```bash
npm run loopgen -- run loops/instances/<slug>.loop.yaml -d grok
```

Offline development on the engine itself can use `-d mock` only when you add mock `steps`
(not included in templates).

## Trust posture (all work templates)

- `specGuard: error` — agent cannot edit the spec
- `evaluatorGuard: error` — agent cannot edit guarded test files
- `maxCostUsd` / `maxIterations` — spend ceiling

Match `ci/canary.loop.yaml` when tightening further.
