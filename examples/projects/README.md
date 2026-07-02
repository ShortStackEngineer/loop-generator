# Self-contained projects

Each example here is a full, runnable project in its own directory: a `project/`
the loop edits, the checks that score it, its own README, and the `.loop.yaml`
that ties them together. Unlike the specs in
[`../building-blocks`](../building-blocks) and [`../patterns`](../patterns) —
which you point at your own repo via `workspace.dir` — these run as-is, with no
external target.

| Project | What it optimizes | Offline |
| --- | --- | --- |
| [`eval-classifier/`](./eval-classifier) | a sentiment classifier to **macro-F1 ≥ 0.80** | ✅ zero-dep, no model needed |
| [`eval-prompt/`](./eval-prompt) | a prompt to **exact-match ≥ 0.90** against a live model | ❌ needs an OpenAI-compatible endpoint |

See each project's README for how to run it.
