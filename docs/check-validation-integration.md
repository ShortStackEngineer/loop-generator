# Check validation inside an ordinary loop

Opt in on a `.loop.yaml` so loopgen proves the spec's command evaluators
distinguish a known-good control from explicit faulty fixtures **before** the
RED baseline or any agent turn. The ordinary run receipt keeps that evidence
and its limitations. Specs without the option are unchanged.

This is tamper-evident provenance, not a sandbox and not continuous
monitoring. Manifest commands are still trusted executable input.

## Spec field

```yaml
checkValidation:
  manifest: ./acceptance.checks.yaml
```

`manifest` is a nonempty string. Relative paths resolve against
`RunOptions.baseDir` (the spec file's directory for the CLI; the library
`baseDir` you pass to `engine.run`). Fixture directories in the manifest still
resolve beside the checks file, even when the loop workspace is somewhere else.

Invalid shapes (`null`, a bare string, `{}`, an empty or non-string
`manifest`) fail `parseSpec`. Missing or malformed manifests fail closed:
outcome `preflight-failed`, zero iterations, no manufactured report.

## Binding to command evaluators

Every manifest check must bind to **exactly one** `command` evaluator.
Matching proves the spec and the manifest declare the **same invocation**
(alias, command text, timeout) — not that every fixture script, candidate
workspace file, or transitive dependency (interpreter, packages, PATH
binaries) is identical.

| Must match | How |
| --- | --- |
| Alias | Check `id` equals the evaluator's effective alias (`as`, or `uses` if `as` is omitted) |
| Command | Exact `options.command` string |
| Timeout | Exact `options.timeoutMs`. Command evaluators have **no default timeout** — the spec must set one, equal to the check's effective timeout (manifest default `10000`) |

Rejected **before any check command runs**:

- Duplicate or ambiguous aliases
- Non-command evaluators (they cannot satisfy a binding)
- Non-root `cwd` (anything other than omitted / `""` / `"."` / `"./"`)
- Nonempty `env` (an empty object is default-equivalent and allowed)
- `expectExitCode` other than `0` (omitted or explicit `0` is allowed)
- `scoreRegex` / `scoreGte` / `scoreLte`
- `null` for `cwd`, `env`, or `expectExitCode` — those fields are invalid on
  the command evaluator schema, not default-equivalent. Omit them (or use
  `0` / `{}` where that is identical to the default).

Existing command-evaluator behavior is not changed. Evaluators the manifest
does not cover are listed on `LoopReport.checkValidationUnmappedEvaluators`
and a warning; they still run as ordinary loop checks.

The gate runs the bound commands against the **supplied** control and
counterexample fixtures. It does not inventory or execute the candidate
workspace, and it does not verify transitive command dependencies.

## When it runs

The gate runs after plug-ins resolve and **before** ordinary preflight,
baseline, and the agent. `skipPreflight` and `limits.baseline: false` cannot
bypass it.

| Gate result | Loop outcome | Agent? |
| --- | --- | --- |
| `validated` | ordinary loop continues | later, if baseline allows |
| `gaps` or `error` | `preflight-failed`, zero iterations | no |
| missing / malformed / bind failure | `preflight-failed`, zero iterations, no report | no |
| cancelled before or during validation | `aborted` | no |

A `CheckValidationReport` (goal, assumptions, explicit `gaps`, claims,
counterexamples) is attached as `LoopReport.checkValidation` on every
**subsequent** outcome — success, `max-iterations`, `budget-exceeded`,
`baseline-vacuous`, `aborted` after the gate, `error`, `evaluator-tampered`,
later preflight failure. Explicit free-form `gaps:` from the manifest stay on
that report even when the examples validate.

## Input integrity

This is **point-in-time tamper evidence**, not a sandbox and not continuous
monitoring of every byte during a check command.

Before parsing the manifest, loopgen does a bounded read (stat size **and**
actual bytes read vs limits; symlinks and special files rejected). Those
bytes are what get parsed. A second capture after parse must hash to the
same manifest digest or the gate fails closed without running checks — so
the parsed document and `checkValidationInputs` cannot silently refer to
different versions.

The inventory covers the manifest and every recursive fixture file with
`lstat` (symlinks and special files are rejected; replacement root
symlinks are **not** followed). Empty directory structure is part of the
comparison. Unreadable or oversized inputs fail closed (`preflight-failed`).

The snapshot is attached as:

```ts
checkValidationInputs: {
  manifest: string;                 // absolute path
  hashes: Record<string, string>;   // absolute path → sha256
}
```

covering the manifest and all recursive fixture **files**. The engine
re-verifies that snapshot:

- immediately after the validation commands finish
- after the ordinary RED baseline
- after **each completed iteration**
- on **every** later terminal path: `success`, `max-iterations`,
  `budget-exceeded`, `aborted` (including cancellation during the last
  permitted agent turn), `error`, later `preflight-failed`

Additions, deletions, content changes, empty directories, and symlink
replacement all count. A changed contract cannot become `success` or
`baseline-vacuous`; on an opted-in run the outcome is `evaluator-tampered`
and the **original** validation evidence is retained. Spec-tamper still
takes precedence when that guard would fail the run (`spec-tampered`).
Without input tampering, cancellation after an agent turn stays `aborted`
even on the last permitted turn. Specs that omit `checkValidation` keep
their previous outcomes.

## CLI

The ordinary `loopgen run` summary includes a one-line gate result:

```
check validation: validated
check validation: gaps
check validation: error
```

The `--report` JSON is the full `LoopReport`, including `checkValidation` and
`checkValidationInputs`. Batch items use the same engine path.

Standalone `loopgen validate-checks` is unchanged — see
[Validating the checks](./check-validation.md).

## Runnable example

Try the offline [integrated example](../examples/check-validation/integrated.loop.yaml)
and its [instructions](../examples/check-validation/README.md#ordinary-loop-with-validation).
It uses the mock driver and requires no provider credentials.
