# Validating the checks themselves

A green loop is only as strong as the checks that declared it done. This command
does not run an agent. It runs *your checks* against a known-good fixture and
against explicit faulty ones, and reports whether those checks actually
discriminate.

```
$ npm run loopgen -- validate-checks examples/check-validation/strong.checks.yaml --report evidence.json
```

A **validated** result means: every control check passed, and every supplied
faulty fixture was rejected by a check mapped to its claim. That is evidence
about *these examples*. It is not proof that every possible faulty
implementation would fail, that production is correct, or that the checks are
the right contract.

A **weak check** shows up as an escaped counterexample (`outcome: gaps`). A
**broken harness** (timeout, abort, missing binary, unexpected exit, control
rejection) shows up as `outcome: error` — never as a catch. An unexpected
crash is an error only when its exit code is *not* in `rejectExitCodes`; exit
codes alone cannot tell an assertion failure from a crash when both use the
same code (often `1`). An **uncovered claim** (no mapped counterexample)
remains a gap. Free-form `gaps:` you wrote on the manifest stay on the report
even when the examples validate.

This does not change existing `.loop.yaml` run success semantics, and old specs
do not need a checks manifest. To require the same evidence **before** an
ordinary loop spends an agent turn, set `checkValidation.manifest` on the
`.loop.yaml` — see [Check validation inside a loop](./check-validation-integration.md).

## Manifest (`.checks.yaml` or JSON)

```yaml
version: 1
name: answer-contract
goal: Return the correct answer without losing the user's intent.
assumptions:
  - The input domain is the supplied fixtures.
gaps:
  - Production behavior is unobserved.
claims:
  - id: correct
    description: The answer is 42
    checks: [answer]
checks:
  - id: answer
    command: "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8').trim() === '42' ? 0 : 1)\""
    timeoutMs: 2000          # default 10000; must be a positive integer
    rejectExitCodes: [1]     # default [1]; nonempty integers in 1..125
control:
  dir: fixtures/good
counterexamples:
  - id: wrong-answer
    claim: correct
    dir: fixtures/bad
```

Rules:

- `version` must be `1`. `name`, `goal`, IDs, descriptions, commands, and dirs
  are nonempty. `claims`, `checks`, `counterexamples`, and each claim's check
  refs are nonempty.
- IDs are unique within each collection (checks, claims, counterexamples).
- Check refs on a claim must name known checks and must not repeat.
- Counterexample `claim` must name a known claim.
- `assumptions` and `gaps` default to `[]`.
- Explicit `rejectExitCodes: []` is invalid. Codes outside 1..125 are invalid.
  Exit `0` always means passed; 126+ (shell/signal) always means error.
- Default `rejectExitCodes: [1]` treats every exit `1` as a rejection. Many
  runtimes also exit `1` on an uncaught exception, so that default **cannot**
  distinguish an assertion failure from a crash. Prefer a distinct rejection
  code (for example `10`) and let ordinary unexpected exits classify as
  errors. A process that dies with the same code you declared for rejection
  still cannot be identified as a crash from the exit code alone.
- Fixture directories resolve **relative to the manifest file**, not the shell
  cwd.

## How a run works

1. For **each** control check, recursively **copy** the control directory into
   a **fresh** OS temp dir — one copy per check, not one shared copy for the
   fixture — run that check command there, capture bounded output + exit code,
   then delete the copy. Source fixtures are not modified.
2. If any control check did not **pass**, stop. Outcome is `error`,
   `counterexamples` is `[]`, and claims are not validated.
3. Otherwise, for every counterexample × every check, do the same: a fresh
   copy per pair, then run, then delete. All checks run even when one rejects.
4. Classify, then write the report.

Exit classification for one command:

| What happened | Status |
| --- | --- |
| Exit `0` | `passed` |
| Exit in `rejectExitCodes` (default `[1]`) | `rejected` |
| Any other exit, timeout, abort, spawn failure, or fixture problem | `error` |

Errors are never counted as caught. Exit `1` is only a rejection when `1` is
in `rejectExitCodes`. If the check instead exits `10` on a deliberate fail
(`rejectExitCodes: [10]`), an uncaught exception that exits `1` is an
`error`, not evidence that the fault was caught. That split works only when
crashes and assertions do **not** share the declared rejection code; not
every crash is identifiable from the exit status.

On timeout or `AbortSignal`, the runner terminates the ordinary shell process
group (POSIX: `kill(-pid, SIGKILL)` after spawning a new group) or process
tree (Windows: `taskkill /T /F`) and waits for cleanup, with output still
bounded. Typical descendants (`node child.cjs` started by the shell) die with
the shell. Children that deliberately leave the process group, daemonize, or
schedule later work are not guaranteed to stop — this is not a sandbox.

A counterexample is **caught** only if at least one check *mapped to its claim*
rejected it **and** no check on that fixture errored. Otherwise it is
`escaped`, or `error` (errors take precedence). An unrelated check that happens
to reject the fixture does not credit the mapped claim.

A claim is **validated** only if it has at least one mapped counterexample and
every one of those is caught. Uncovered or escaped → `gap`. Execution error →
`error`.

Overall `outcome`: `error` if anything errored (including a failed control);
else `gaps` if any claim is a gap; else `validated`.

## Isolation is not a sandbox

Each check runs in **its own** recursive copy of the fixture — a new temp
directory per control/check and per counterexample/check pair, not one shared
copy reused across checks — so a command that writes `answer.txt` cannot
poison the next check or the source tree. **Symlinks** (including the fixture
root), missing/non-directory paths, and special files (fifo/socket/device)
are rejected *before* the command runs, so a check cannot mutate an external
target through a link.

That is isolation of ordinary relative file mutations. It is **not** a security
sandbox. A `.checks.yaml` is trusted executable input: `checks[].command` is a
shell one-liner and can reach anything the process can. Do not feed untrusted
manifests to `validate-checks`.

## Report JSON

```json
{
  "name": "answer-contract",
  "goal": "…",
  "assumptions": ["…"],
  "gaps": ["…"],
  "outcome": "validated",
  "control": [{ "check": "answer", "status": "passed", "exitCode": 0, "feedback": "…" }],
  "counterexamples": [{
    "id": "wrong-answer",
    "claim": "correct",
    "status": "caught",
    "checks": [{ "check": "answer", "status": "rejected", "exitCode": 1, "feedback": "…" }]
  }],
  "claims": [{
    "id": "correct",
    "description": "The answer is 42",
    "status": "validated",
    "caught": ["wrong-answer"]
  }]
}
```

`--report` writes this file when execution produced a report (including
`outcome: error` after a control/harness failure). Invalid manifests do not
produce a report. If the report path cannot be written (the path is a
directory, the parent is missing, or permission is denied), the CLI prints an
actionable error to stderr and exits `2`; it does not fall through to the
generic handler (exit `1`).

## CLI

```
loopgen validate-checks <manifest> [--report <file>]
```

| Exit | Meaning |
| --- | --- |
| 0 | `validated` |
| 1 | `gaps` (escaped or uncovered claims; no execution error) |
| 2 | `error`, including an invalid manifest or a `--report` path that cannot be written |

Stdout is a short summary. Actionable failures go to stderr.

## Library

```ts
import {
  loadChecksFile,
  parseChecksManifest,
  runCheckValidation,
  checkValidationExitCode,
} from "loop-generator";

const { manifest, baseDir } = loadChecksFile("contract.checks.yaml");
const report = await runCheckValidation(manifest, {
  baseDir,            // fixture dirs resolve here, not process.cwd()
  signal,             // optional AbortSignal; temp copies are removed on every path
});
process.exit(checkValidationExitCode(report.outcome));
```

`parseChecksManifest` throws `ChecksManifestError` for schema/reference
problems.

## Offline examples

| Manifest | Check | Expected |
| --- | --- | --- |
| [`examples/check-validation/strong.checks.yaml`](../examples/check-validation/strong.checks.yaml) | reads `answer.txt`, expects `42` | exit 0, `validated` |
| [`examples/check-validation/weak.checks.yaml`](../examples/check-validation/weak.checks.yaml) | `process.exit(0)` | exit 1, `gaps`, counterexample `escaped` |

```bash
npm run loopgen -- validate-checks examples/check-validation/strong.checks.yaml --report /tmp/strong.json
npm run loopgen -- validate-checks examples/check-validation/weak.checks.yaml --report /tmp/weak.json
```

Both share `examples/check-validation/fixtures/{good,bad}`.

## Inside an ordinary loop

Opt in with `checkValidation.manifest` on a `.loop.yaml` to run this gate
before baseline or any agent invocation. Binding matches the declared
command text and timeout (the same invocation), not identical fixture or
candidate implementations, and not transitive command dependencies. Input
integrity is re-checked after validation, after baseline, after each
iteration, and on every later terminal path. Details:
[Check validation inside a loop](./check-validation-integration.md).
