# Check-validation dogfood experiment

## Prepared baseline

- Branch: `codex/validate-checks`, created from master `3b944d60556fe46194e21c56e0519a96ae5de0c7`.
- Existing regression suite: 44 files, 1,005 tests passed.
- Typecheck and build passed.
- New black-box CLI acceptance: 16 tests failed before implementation because
  master has no `validate-checks` command.
- Spec lint: no errors, warnings, or informational findings.
- Grok headless authentication probe returned READY.

The first regression attempt in the restricted sandbox timed out in an existing
`verifySpec` test. The focused test and full suite passed outside the sandbox.
No existing code was changed to obtain the clean baseline.

## Contract and run

- As-authored spec: `loops/instances/validate-checks.loop.yaml`.
- Acceptance: `test/acceptance/validate-checks.test.ts`.
- Design/scope: `docs/check-validation-plan.md`.
- Local raw evidence: `.loopgen/validate-checks/` (gitignored).
- Master runner: copied to an OS temporary directory before implementation;
  path recorded in `.loopgen/validate-checks/runner-path.txt`.
- Contract SHA-256 hashes: `.loopgen/validate-checks/contract-hashes.json`.
- Pre-run file hashes: `.loopgen/validate-checks/pre-run-files.json`.

The user approved source transfer to xAI. A frozen master loopgen runner drove
Grok inside a disposable container, with independent read-only acceptance checks
and offline snapshot evaluation. Both runs completed successfully:

| Run | Baseline | Iterations | Result | Reported cost |
| --- | --- | --- | --- | --- |
| Initial feature | 16 CLI acceptance failures | 2 (first interrupted) | success | $0.2387344 |
| Independent review repairs | 3 new reproductions failed | 1 | success | $0.14699356 |

The first interrupted iteration has no usage record, so these costs are **not**
a complete billing total. Both final reports have no run warnings; preflight
noted that Grok was using cached login. The original 16-test acceptance contract
and as-authored spec hashes remain unchanged.

The initial green missed surviving child processes on timeout/abort and the
wrong CLI exit code for report-write failures. Independent review found those
issues; a second guarded loop fixed them. The final candidate then passed a
fresh offline build, typecheck, 1,055 source tests and 16 CLI acceptance tests,
with source-integrity verification before transfer to the original checkout.

See [review findings](validate-checks-review.md), [isolation boundaries](validate-checks-isolation.md),
and the compact [run receipt](validate-checks-receipt.json). Raw reports and
traces are preserved locally in `.loopgen/validate-checks/completed-runs/`.

## Integration and additional verification

The implementation source was transferred unchanged from the reviewed candidate.
The orchestrator then separated built-CLI acceptance into `npm run test:acceptance`
and the CI build job, so source coverage needs no prebuilt output. The report-I/O
CLI reproduction moved into that suite without changing its assertion.

Test-only refinements removed process-wide `chdir` calls incompatible with
Stryker workers and made abort cleanup assertions inspect only their own temp
copy. Initial targeted mutation analysis scored 58.38%, below the unchanged 70%
gate. Independent tests now cover diagnostic evidence, report-write failures,
fixture traversal/copy failures and cancellation between copying and execution.
These test and CI changes were made by the orchestrator after the Grok runs.

Final integration verification:

- Typecheck and build passed.
- Source suite + coverage: 50 files, 1,095 tests passed. Lines/statements 97.46%,
  functions 99.34%, branches 93.61%; existing thresholds unchanged.
- Built CLI acceptance: 17 tests passed (original 16 plus report-write error).
- Targeted Stryker run: **77.74%**, above the unchanged 70% break threshold;
  656 mutants, 509 killed, 1 timed out, 111 survived, 35 uncovered. This covers
  the six new core modules, not a rerun of whole-repository mutation testing.
- Offline mock demo: success in two iterations. Mock driver conformance passed,
  with its existing advisory that an already-aborted signal is ignored.
- Original contract hashes unchanged; all nine implementation source files match
  the independently verified Grok candidate. `git diff --check` passed.

Commands: `npm run typecheck`, `npm run test:acceptance`,
`npm_config_offline=true npm run coverage`, and
`npm_config_offline=true npx stryker run .loopgen/validate-checks/stryker.final.json`.
The local Stryker config selects `src/check-validation/**/*.ts` and
`test/check-validation*.test.ts`, with four mutation workers. The config, full
mutation JSON and final logs are retained in `.loopgen/validate-checks/`.
Stryker required permission to open its local worker logging socket; it ran
offline. No check thresholds or mutation operators were relaxed.

The existing `generate.test.ts` timeout in the restricted environment was
avoided by running npm in offline mode; no existing implementation or assertion
was changed. At that stage, Windows termination and some OS failure/fallback paths remained
unverified; `exec.ts` scored 45.96% individually. Passing the aggregate mutation
gate does not establish complete process-runner coverage.

## Completion criteria

Record the loop outcome, iterations, usage, guard results, independent review,
coverage/mutation checks, and any fixes made after the agent run. Preserve raw
reports; distinguish loop-generated implementation from orchestrator changes.
A successful run supports this feature/task/driver combination, not a general
claim that all user requests are covered by their checks.

## Branch hardening on September 8

Added 19 deterministic process-adapter tests covering both output streams and
capture budgets, elapsed time, spawn errors, listener/timer cleanup, cancellation
during spawn, delayed/missing close events, POSIX fallback, and Windows taskkill
arguments/fallback. These complement the real POSIX child/grandchild tests.
Windows calls are simulated; no native Windows execution is claimed. The
implementation source remains identical to the reviewed Grok candidate.

The full source suite now passes 1,114 tests in 51 files; all 17 built CLI
acceptance tests pass. Coverage is 98.05% lines/statements, 99.34% functions and
94.01% branches. Typecheck passed. The next slice is specified separately in
[the integration plan](../../docs/check-validation-integration-plan.md).

Targeted mutation now passes at **89.33%** across all six new modules, with
`exec.ts` at **93.17%** (previously 45.96%). Of 656 mutants, 576 were killed by
assertions, 10 timed out, 61 survived and 9 were uncovered. Thresholds and mutation
operators remain unchanged. The latest logs and JSON are saved as
`.loopgen/validate-checks/{coverage,acceptance,mutation}-hardening.log` and
`.loopgen/validate-checks/mutation-hardening.json`.
