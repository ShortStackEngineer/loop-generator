# Independent review after the first green

The first implementation run passed its 16 black-box acceptance checks, the
existing regression suite, build and typecheck. A fresh offline snapshot also
passed, and coverage passed. The original source checkout remained untouched.

Review then identified failures not covered by the first acceptance contract:

1. A shell child could outlive the check timeout and still write a file.
2. A shell child could likewise outlive AbortSignal cancellation.
3. An unwritable report destination returned CLI exit 1 instead of error exit 2.

The orchestrator wrote four independent tests in
`test/check-validation-review.test.ts`: the three reproductions failed on the
first implementation, while distinct-code crash classification already passed.
The new tests were mounted read-only for the repair run. The original acceptance
suite is unchanged. A separate follow-up loop implemented the fixes and passed
all original checks as well as these reproductions in one iteration.

The review also requests documentation that exit codes alone cannot distinguish
a crash from a rejected assertion when both exit 1; a dedicated rejection code
can distinguish these cases when the check follows that convention.

This is a concrete example of acceptance refinement: the first green described
its supplied checks accurately but did not establish complete correctness.

The first run took two iterations (the first was interrupted). It reports
$0.2387344 in captured usage, but the interrupted attempt has no usage record,
so that number is not a complete billing total. Raw phase-one evidence is kept
separately from the repair run; no earlier result is rewritten.

The repair report recorded success with no run warnings and $0.14699356 in
reported usage. A fresh offline snapshot passed before source transfer.

After transfer, the report-write CLI test moved to
`test/acceptance/validate-checks-report.test.ts`; the three source/API review
tests remain in `test/check-validation-review.test.ts`. Additional independent
tests strengthen mutation sensitivity without changing the original acceptance
contract or the loop-generated implementation. Windows process-tree termination
is implemented but has not been exercised on Windows in this experiment.

The additional 41 independent tests raised targeted mutation sensitivity from
58.38% to 77.74% (656 mutants; gate remains 70%). Report writing reached 100%,
fixture handling 88.42%, and runner reporting/control flow 89.92%. At that stage, the process
execution helper was less thoroughly covered at 45.96%; ordinary POSIX
child/grandchild termination is tested with real processes, but this is not a
claim of exhaustive OS or Windows behavior.

September 8 hardening added 19 deterministic process-adapter tests without
changing implementation source. The helper now scores 93.17% and all six modules
score 89.33%. Simulated Windows behavior is covered, but native Windows execution
remains outside this experiment.
