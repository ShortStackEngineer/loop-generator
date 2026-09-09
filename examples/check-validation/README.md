# Check-validation examples

Offline fixtures for `loopgen validate-checks`. No API key, no agent.

Each check runs in its own fresh copy of `fixtures/{good,bad}` — not one
shared copy.

- **strong** — the check reads `answer.txt` and requires `42` (exit 0 pass,
  exit 1 reject). The faulty fixture is caught. With the default reject
  code `1`, an uncaught exception that also exits `1` would look the same;
  use a distinct code such as `10` if you need crashes classified as errors.
- **weak** — the check always exits 0. The faulty fixture escapes.

See [docs/check-validation.md](../../docs/check-validation.md).

```bash
npm run loopgen -- validate-checks examples/check-validation/strong.checks.yaml --report /tmp/strong.json
npm run loopgen -- validate-checks examples/check-validation/weak.checks.yaml --report /tmp/weak.json
```

## Ordinary loop with validation

`integrated.loop.yaml` validates the strong fixtures, confirms the workspace
starts RED, then uses the offline mock driver to write `42`. The JSON report
includes the fixture evidence and input hashes alongside the loop result.

```bash
npm run build
node dist/cli/index.js run examples/check-validation/integrated.loop.yaml --report /tmp/integrated.json
```

The first run succeeds in one iteration. A second run stops as
`baseline-vacuous` because `.workspace/answer.txt` already contains `42`;
remove that generated file to repeat the example. See
[the integration guide](../../docs/check-validation-integration.md) for binding
rules and the limits of the evidence.
