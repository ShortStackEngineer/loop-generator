# Check-validation integration dogfood experiment

Branch: `codex/check-validation-integration`, from merged master `434061f`
(PR #51). Scope: an opt-in `checkValidation.manifest` gate inside ordinary
engine runs, evaluator binding, retained report evidence and input integrity.

## Frozen acceptance

`test/acceptance/check-validation-integration.test.ts` contains 28 checks driven
through the real engine, CLI and batch paths. Before implementation, 27 failed
because integration was absent; the existing pre-abort invariant passed.
Typecheck, build and the existing regression suite passed. Spec lint had no
errors or warnings; the informational documentation warning does not recognize
the wrapper evaluator that explicitly checks the documentation artifact.

## Isolation

A new disposable repository was exported from merged master. The original
checkout and its unrelated `.octo-continue.md` were not copied into or mounted
in the agent container. A separately copied, built master runner supervises the
loop with independent production dependencies. The pinned Node 20 / Grok image
is `sha256:562073c1173cbb641b93136613dd299f98c60064be56a0083192d7eae8833f5f`.

The user previously authorized sending the disposable source and instructions
to xAI. Only Grok provider credentials enter its disposable state. Containers
have read-only roots, dropped capabilities, bounded resources, protected tests
and dependencies, no Docker socket and no original checkout mount. Agent
network access is enabled for Grok; offline evaluation containers have none.
The re-audited allowlist permits engine/spec integration edits that were
protected in the first experiment. The isolation probe passed before launch.

Each evaluator rebuilds a fresh snapshot, overlays read-only authoritative
checks, and compares source hashes afterward. The agent has no access to the
supervisor, reports or evidence directory. A successful loop is followed by a
new independent offline build, acceptance, regression and typecheck.

## Initial implementation and review

The first loop succeeded in two iterations. The first attempt hit the 12-minute
process timeout (exit 124); the second fixed remaining type errors and passed
all four original gates. A fresh offline verification passed. Reported usage
was $0.07997582, but the timed-out attempt has no usage record: this is not a
complete billing total.

Independent review then added 12 checks, seven of which failed:

- Input integrity was not checked on exhausted/aborted terminal paths.
- Cancellation during the last agent turn could report max-iterations.
- Null cwd/env/expectExitCode values were treated as defaults despite being
  invalid command-evaluator options.
- The manifest could change between parsing and hashing, producing a receipt
  whose hash described a different version than the one validated.

The initial run also omitted the requested source unit tests. A separate repair
loop protects all original and review checks and adds a coverage evaluator for
`bind.ts`, `gate.ts` and `inventory.ts` at the existing 85% line/function/statement
and 80% branch thresholds. No acceptance assertion or threshold was relaxed.

## Repair and independent final review

The repair loop succeeded in three iterations. Its first attempt reached the
25-turn limit and passed behavior checks but lacked source coverage; its second
hit the process timeout and left test filenames outside the allowed scope. The
third corrected the filenames and passed acceptance, regression, documentation,
typecheck and coverage. The new modules reached 100% lines/functions/statements
and exceeded the unchanged 80% branch threshold.

Reported repair usage was 382,062 input tokens, 50,927 output tokens, 46 turns
and $0.45458646. Together, the two runs report $0.53456228. Both runs contain a
timed-out attempt without usage, so these figures are incomplete billing data.

Three further independently authored tests initially failed: simultaneous spec
and fixture tampering lost spec-tamper precedence; last-turn cancellation changed
an old spec's outcome; and an old spec's callback exception stopped propagating.
The reviewer fixed these directly after the Grok run, also preserving the old
mid-iteration guard timing. All three tests then passed. These final fixes are
manual post-loop changes, not evidence of an entirely autonomous implementation.
No protected assertion or test threshold was weakened.

A fresh offline snapshot then passed build, all acceptance tests present in the
candidate, 1,196 source tests and typecheck. Only allowed implementation files
and the reviewed new tests were transferred; the original 28 acceptance checks
were byte-identical to the frozen contract.

## Local verification

- Typecheck and production build passed.
- Source suite: 1,196 tests passed.
- Acceptance suite: 60 tests passed, including the three final review cases.
- Coverage: 95.84% lines/statements, 99.10% functions, 93.82% branches.
- New bind/gate/inventory modules: 100% lines/functions/statements;
  branch coverage 100%, 94.82% and 96.85%, respectively.
- Fresh integrated mock example: validated evidence, RED baseline, success in
  one iteration. Second run: validated evidence retained, `baseline-vacuous`.
- Existing offline mock smoke passed.
- Focused mutation testing of `bind.ts`, `gate.ts` and `inventory.ts`: 88.38%
  across 594 mutants, above the unchanged 70% gate. The focused run uses source
  and integration tests; the built-CLI case runs separately in acceptance.

## Evidence and scope limits

Local raw evidence and harness material are retained under
`.loopgen/check-validation-integration/` (gitignored). The disposable root is
recorded in `isolation-path.txt`; both phases’ reports and control hashes are archived in
`completed-runs/phase1/` and `completed-runs/phase2/`. `harness/` preserves the
credential-free evaluator/launcher configuration; `offline-final-receipt.json`
and `transfer-receipt.json` record the source hashes. Final review, coverage,
acceptance, mutation and smoke logs are retained beside them.

Matching alias, command text and options establishes the same declared
invocation. It does not establish identical script/dependency implementations
across fixtures and the candidate. Validation concerns the supplied examples;
input hashes are point-in-time tamper evidence, not continuous monitoring or a
security sandbox. Independent final-candidate acceptance remains a later slice.

The integration is complete on `codex/check-validation-integration`, ready for
review. Full-repository mutation testing was not rerun; the mutation gate above
is scoped to the three new modules.
