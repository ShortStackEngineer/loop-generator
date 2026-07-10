# Observing runs

> **Canonical version:**
> **<https://shortstackengineer.github.io/loop-generator/docs/observing.html>**
> This file is a stub — the site page is the full, maintained reference. Edit
> `site/docs/observing.html`, not this file.

Evaluators tell you *what* failed; the trace tells you *why the agent didn't
fix it*. Every run can stream three layers of evidence — the outcome, each
iteration, and the agent's inner trajectory — as JSONL (`--trace file.jsonl` or
the `jsonl` observer) or standard OTLP spans (the `otlp` observer, zero OTel
dependency). The site page documents:

- The three evidence layers and the `TraceRecord` kinds
  (`run.start | agent.event | iteration.end | signal | run.end`).
- Observer options for `jsonl` and `otlp` (file, endpoint, OTLP env vars) and
  the run → iteration → turn → tool span tree.
- Driver event fidelity, writing your own observer, and the library seams
  (`runWithTrace`, `RunOptions.onAgentEvent`).

Contracts: `src/observers/types.ts` and `src/observability/`.
