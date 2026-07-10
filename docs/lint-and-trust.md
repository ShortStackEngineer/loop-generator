# In depth: linting and trustworthy results

> **Canonical version:**
> **<https://shortstackengineer.github.io/loop-generator/docs/trust.html>**
> This file is a stub — the site page is the full, maintained reference. Edit
> `site/docs/trust.html`, not this file.

Two related ideas: `loopgen lint` catches a bad spec *before* any agent runs,
and the engine's trust guards keep a finished run from reporting a false "all
checks passed." The site page documents:

- **Trustworthy results** — how each guard works and its honest limits: change
  detection (git-index diff + content-hash fallback), baseline evaluation,
  sequential evaluators, the spec- and evaluator-integrity guards, honest
  `stopReason` reporting, and budget ceilings.
- **Linting before you run** — every rule (`SPEC-WORKDIR-NOT-PROJECT`,
  `SPEC-EVAL-BINARY-MISSING`, destructive-env, shared-resource, self-fulfilling
  smoke tests, the batch rules), severities, and exit codes.

Implementation source of truth: `src/core/workspace.ts`,
`src/core/evaluator-guard.ts`, and `src/lint/rules.ts`.
