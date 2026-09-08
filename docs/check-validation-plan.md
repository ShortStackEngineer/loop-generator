# Check validation: first implementation slice

The user goal is stronger evidence that an agent delivered the requested outcome.
This branch begins with executable validation of the checks, preserving the goal,
assumptions, uncovered claims, and explicit limitations in the output.

## First slice: an offline check-validation command

`loopgen validate-checks contract.checks.yaml --report evidence.json`

Users supply a known-good fixture, deliberately faulty fixtures, check commands,
and mappings from claims to checks and counterexamples. A validated result means
all control checks passed and every supplied faulty fixture was rejected by a
relevant check. It is not proof that all possible faulty implementations fail.
A weak check yields an escaped counterexample; a broken harness yields an error.
An uncovered claim remains a gap. Explicit product uncertainties remain visible.

Manifest and report details are frozen in loops/instances/validate-checks.loop.yaml.
Black-box acceptance tests are in test/acceptance/validate-checks.test.ts. They
invoke the built CLI on real temporary fixtures. Invariants are the existing test
suite, typecheck, and build. Acceptance starts red because the CLI command does
not exist on master. No implementation is prewritten by the orchestrator.

## Dogfood experiment

1. Record master revision and baseline checks.
2. Freeze a built master runner outside the editable source tree.
3. Use that runner with the Grok driver to implement this feature, with guarded
   tests/spec/configs, a four-iteration limit and an $8 reported-usage ceiling.
4. Keep the as-run spec, report, and trace; inspect changes and run additional
   acceptance scenarios after completion. Budget enforcement depends on driver
   usage reporting and is checked between iterations, not a hard billing cap.
5. Promote the acceptance suite into normal regression coverage after success.

Success demonstrates this particular loopgen version can drive this particular
feature to independently authored checks with Grok. It does not establish general
reliability or that an arbitrary natural-language request is fully covered.
Fixture copies are not a security sandbox for shell commands; trusted manifests
can execute arbitrary code. Do not describe hash guards as preventing all tampering.

## Later slices

- Integrate structured intent and evidence with ordinary LoopReport output.
- Independent acceptance on a fixed candidate, with fresh cases after repairs.
- First-class manual review and post-release observation states.
- Compare this approach with the current framing workflow on a fixed task set.

The first slice does not automatically generate counterexamples, replace the
existing engine, or change the success semantics of existing .loop.yaml specs.
