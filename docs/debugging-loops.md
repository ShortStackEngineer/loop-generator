# Debugging a run

> **Canonical version:**
> **<https://shortstackengineer.github.io/loop-generator/docs/debugging.html>**
> This file is a stub — the site page is the full, maintained guide. Edit
> `site/docs/debugging.html`, not this file.

Diagnose a failed, stalled, errored, or suspiciously-green run by its
`LoopReport.outcome`, and reproduce the failing check cheaply — lint plus
running the check by hand, zero agent turns — before spending any more budget.
The site page covers:

- Gathering the evidence (`--report`, `--trace`, the warnings list).
- Classifying by outcome (`max-iterations`, `preflight-failed`,
  `baseline-vacuous`, `spec-tampered`, `evaluator-tampered`,
  `budget-exceeded`, `error`, …) and the fix each one points to.
- Drilling into a `max-iterations` failure and investigating a suspicious
  success.

If you use Claude Code, the in-repo `debug-loop` skill
(`.claude/skills/debug-loop/`) runs this workflow for you.
