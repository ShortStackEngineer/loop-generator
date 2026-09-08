# Check validation inside an ordinary loop

## Outcome

A user can require evidence that their checks distinguish good and faulty
fixtures before loopgen spends an agent turn. The ordinary run receipt retains
that evidence and its limitations. Existing specs without the option keep their
current behavior.

Proposed opt-in syntax:

```yaml
checkValidation:
  manifest: ./acceptance.checks.yaml
```

The manifest path resolves beside the loop spec (`RunOptions.baseDir` for the
library); fixture paths continue to resolve beside the checks manifest.

## Contract to freeze before the next Grok run

1. A valid strong manifest allows the ordinary baseline and agent loop to run.
   `LoopReport.checkValidation` contains the complete validation report on all
   subsequent terminal paths, preserving goal, assumptions and explicit gaps.
2. An escaped counterexample, uncovered claim, rejected control or execution
   error prevents agent invocation. Return `preflight-failed`, zero iterations,
   actionable diagnostics and the validation report when one was produced.
   Missing/malformed manifests fail closed without manufacturing evidence.
3. Cancellation before or during validation stops work, cleans temporary copies,
   invokes no agent and returns `aborted`. Neither `skipPreflight` nor disabling
   the ordinary RED baseline bypasses an explicitly requested validation gate.
4. Validation must measure the actual checks used by the loop. For this first
   integration, require each manifest check ID to match a command evaluator's
   alias and its command and effective timeout to match that evaluator. Reject
   mismatches before running commands; do not imply coverage of experiment or
   other evaluator types. Report any evaluator outside that mapping explicitly.
5. Preserve the evidence's provenance: record the manifest and fixture content
   digests used for validation. Detect changes to those inputs before accepting
   the final candidate, including deletion or symlink replacement. A changed
   validation contract cannot produce an ordinary successful receipt. Reuse the
   existing evaluator-tampered outcome with actionable paths; retain original
   validation evidence rather than silently rerunning against changed fixtures.
6. The built CLI's JSON report and concise summary expose the gate outcome. The
   CLI, library and batch execution must use the same engine path.
7. Existing specs, RED baseline, evaluator/spec guards, budgets and observer
   behavior retain their existing contracts. Validation of supplied examples is
   separate from independent acceptance of the final implementation.

## Acceptance scenarios

Exercise the real engine with an instrumented mock driver whose invocation count
and file writes are asserted. Use independently created good/faulty fixture
scripts, randomized temporary paths, and exact JSON evidence assertions. Cover:

- strong, weak, crashing and malformed manifests;
- a valid manifest beside a spec whose workspace is elsewhere;
- mismatched alias/command/timeout, plus an unmapped evaluator;
- pre-abort, cancellation during a long check, and skipPreflight bypass attempts;
- success, exhausted iterations and failed baseline retaining the evidence;
- an agent changing/deleting the manifest or changing/replacing a fixture;
- an old spec without checkValidation producing its original behavior;
- built CLI and batch propagation.

The new behavioral tests must fail on the committed standalone feature before
launch. Existing regression/build/typecheck are GREEN invariants. Keep the new
acceptance assertions and all existing tests immutable during the run. Add fresh
independent review cases after the first green.

## Execution boundaries

Use a new disposable repository and evidence directory, frozen runner built from
the committed first slice, pinned dependency image and read-only acceptance
contract. Reuse the previously approved isolated Grok workflow: no original
checkout or Docker socket in the agent container; only Grok provider credentials
in disposable state; offline fresh-snapshot evaluation before reviewed transfer.
Re-audit the writable-file allowlist and isolation probe because this slice must
modify the engine and spec schema that were read-only in the first experiment.
Do not reuse the old launcher's control hashes or overwrite earlier run evidence.

The broader experiment set and a separate final-candidate acceptance stage follow
this integration. This document is a proposed next-run contract, not evidence
that the integration has been implemented or that its checks already start RED.
