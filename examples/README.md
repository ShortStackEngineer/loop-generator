# Examples

A guided tour of loop-generator, ordered so you can learn by running: start with
the offline demo, work through one mechanism at a time, then see full loop
patterns and self-contained projects.

Examples come in two shapes:

- **Single-file specs** (`*.loop.yaml`, `*.batch.yaml`) — illustrative specs you
  point at *your own* repo via `workspace.dir`. They lint and read as-is; the
  agent-driven ones warn that `./target` doesn't exist until you set it, which is
  expected.
- **Self-contained projects** — a directory with its own runnable `project/` and
  README, no external repo needed. These live in [`projects/`](./projects).

Every spec parses and lints with zero errors, and each keeps its success criteria
in a file *outside* the workspace the agent edits, so the agent can't quietly
rewrite its own contract. Run `npm run loopgen -- lint <file>` on any of them first.

> **Invoking the CLI:** the commands below use `npm run loopgen -- <args>`, which
> works from the repo root with no build step. If you've installed loop-generator
> globally — or run `npm run build && npm link` once — you can drop the prefix and
> use `loopgen <args>` directly.

## Building blocks

Minimal specs in [`building-blocks/`](./building-blocks), each isolating one
mechanism. Start with `mock-demo`: it runs offline with the scripted `mock`
driver (no API key) and is the fastest way to watch the fail → feedback → fix
loop turn over.

| File | Driver | Shows |
| --- | --- | --- |
| [`mock-demo.loop.yaml`](./building-blocks/mock-demo.loop.yaml) | mock (offline) | **Start here.** The core loop end-to-end: a check fails, feedback, then passes |
| [`observed-demo.loop.yaml`](./building-blocks/observed-demo.loop.yaml) | mock (offline) | The same loop with `jsonl` + `otlp` observers attached — writes an execution trace and an OTLP span file |
| [`function-fizzbuzz.loop.yaml`](./building-blocks/function-fizzbuzz.loop.yaml) | Claude Agent SDK | A `function` task: implement + tests + typecheck |
| [`api-feature-grok.loop.yaml`](./building-blocks/api-feature-grok.loop.yaml) | grok | An `api` task driven by the grok CLI |
| [`copilot-feature.loop.yaml`](./building-blocks/copilot-feature.loop.yaml) | github-copilot | A `function` task driven by the GitHub Copilot CLI |
| [`opencode-feature.loop.yaml`](./building-blocks/opencode-feature.loop.yaml) | opencode | A `function` task driven by opencode against a local model |
| [`experiment-ab.loop.yaml`](./building-blocks/experiment-ab.loop.yaml) | Claude Agent SDK | An `experiment` task: converge on a metric with the `experiment` evaluator |
| [`punch-list.batch.yaml`](./building-blocks/punch-list.batch.yaml) | mock (offline) | A batch: bounded concurrency, distinct workspaces, and a `needs` dependency |

```bash
# offline, no API key:
npm run loopgen -- run   examples/building-blocks/mock-demo.loop.yaml
npm run loopgen -- run   examples/building-blocks/observed-demo.loop.yaml
npm run loopgen -- batch examples/building-blocks/punch-list.batch.yaml
```

Any spec can also produce a one-off trace without an observability block:
`npm run loopgen -- run <spec> --trace trace.jsonl` (see
[Observing runs](../docs/observing-runs.md)).

## Loop patterns

Established agent-looping patterns in [`patterns/`](./patterns), each written as a
spec with loopgen's trust guards turned on — which makes them lintable,
reproducible, and guarded against false positives.

| Pattern | Origin | What it is | Spec |
| --- | --- | --- | --- |
| **Ralph Wiggum loop** | Geoffrey Huntley · Addy Osmani | One agent grinds a fix-list to empty, persisting learnings as it goes | [`ralph-loop.loop.yaml`](./patterns/ralph-loop.loop.yaml) |
| **Evaluator-optimizer / verifiable goal** | Anthropic · Boris Cherny | Goal + a separate deterministic checker; agent iterates until every check passes | [`evaluator-optimizer.loop.yaml`](./patterns/evaluator-optimizer.loop.yaml) |
| **Loop-engineering harness** | Addy Osmani | discover → implement → verify as distinct stages (maker ≠ checker) | [`osmani-harness.batch.yaml`](./patterns/osmani-harness.batch.yaml) |

What each relies on, and what the declarative version adds:

- **Ralph** uses a `plan-complete` check (`! grep "\[ \]" fix_plan.md`) so "the
  list is empty" is a real stop condition, plus no-op detection so a green turn
  that changed nothing can't claim progress.
- **Evaluator-optimizer** sets `baseline: strict`: if the checker is already green
  before the agent starts, it isn't testing the new behavior, so the run fails as
  `baseline-vacuous` instead of reporting a hollow success.
- **Harness** uses the batch scheduler's `needs` ordering and same-workspace
  exclusivity so the maker and checker stages run in order within one repo. Its
  sub-specs live in [`patterns/osmani-harness/`](./patterns/osmani-harness).

All three drive a real agent, so they need a driver (Claude Agent SDK with
`ANTHROPIC_API_KEY`, or grok) and a `./target` repo to edit. You can lint them
with no agent at all; they warn that `./target` doesn't exist yet, which is
expected — so don't add `--strict`, or that expected warning becomes a non-zero
exit:

```bash
npm run loopgen -- lint examples/patterns/ralph-loop.loop.yaml
npm run loopgen -- lint examples/patterns/osmani-harness.batch.yaml
```

## Self-contained projects

Unlike the specs above, the examples in [`projects/`](./projects) run end-to-end
with no external repo: each is a directory with a runnable `project/`, the checks
that score it, and its own README. Both optimize an eval until a metric clears a
bar, with the guards that keep "optimize until the number passes" from being
gamed — the scorer and labeled data are guarded (`evaluatorGuard: error`), so an
agent can only move the metric by changing the model or the prompt, and the score
is read on held-out data.

| Example | Metric | Model under test | Offline |
| --- | --- | --- | --- |
| [`projects/eval-classifier/`](./projects/eval-classifier) | **macro-F1** ≥ 0.80 | a rule-based classifier the agent edits | ✅ zero-dep, runs with no model |
| [`projects/eval-prompt/`](./projects/eval-prompt) | **exact-match accuracy** ≥ 0.90 | a live LLM; the agent optimizes the prompt | ❌ needs an OpenAI-compatible endpoint (LM Studio by default) |

```bash
npm run loopgen -- lint examples/projects/eval-classifier/sentiment-f1.loop.yaml
npm run loopgen -- run  examples/projects/eval-classifier/sentiment-f1.loop.yaml   # baseline macro-F1 ≈ 0.33 → drive to ≥ 0.80
```
