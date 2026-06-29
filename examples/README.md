# Examples

Two ways in. If you already run an agent loop and want to see it expressed here,
start with **the popular loops**. If you're learning the schema, start with **the
building blocks** further down.

Every spec here parses and lints with **zero errors**. The agent-driven ones warn
that `./target` doesn't exist yet — that's expected; point them at your own repo.
Each keeps its success criteria in a file *outside* the workspace the agent edits,
so the agent can't quietly rewrite its own contract. Run `loopgen lint <file>` on
any of them first.

## The popular loops, recreated

These are faithful, runnable recreations of the loops people reference most in
2026 — the same patterns, expressed declaratively and with loopgen's trust guards
turned on. The point is to show that what you're already doing ad-hoc becomes
lintable, reproducible, and hard to fool.

| Pattern | Origin | What it is | Here | Run |
| --- | --- | --- | --- | --- |
| **Ralph Wiggum loop** | Geoffrey Huntley · Addy Osmani | One agent grinds a fix-list to empty, persisting learnings as it goes | [`ralph-loop.loop.yaml`](./ralph-loop.loop.yaml) | `loopgen run examples/ralph-loop.loop.yaml` |
| **Evaluator-optimizer / verifiable goal** | Anthropic · Boris Cherny | Goal + a separate deterministic checker; agent iterates until every check passes | [`evaluator-optimizer.loop.yaml`](./evaluator-optimizer.loop.yaml) | `loopgen run examples/evaluator-optimizer.loop.yaml` |
| **Loop-engineering harness** | Addy Osmani | discover → implement → verify as distinct stages (maker ≠ checker) | [`osmani-harness.batch.yaml`](./osmani-harness.batch.yaml) | `loopgen batch examples/osmani-harness.batch.yaml` |

What each one leans on, and why it's more than the bash version:

- **Ralph** uses a `plan-complete` check (`! grep "\[ \]" fix_plan.md`) so "the
  list is empty" is a real stop condition, plus no-op detection so a green turn
  that changed nothing can't claim progress.
- **Evaluator-optimizer** sets `baseline: strict`: if the checker is already
  green before the agent starts, it isn't testing the new behavior, so the run
  fails as `baseline-vacuous` instead of reporting a hollow success. That's the
  "trust your checker" rule, enforced mechanically.
- **Harness** uses the batch scheduler's `needs` ordering and same-workspace
  exclusivity so the maker and checker stages run in order, in one repo, for
  free — its sub-specs live in [`osmani-harness/`](./osmani-harness).

All three drive a real agent, so they need a driver — the Claude Agent SDK (with
`ANTHROPIC_API_KEY`) or grok (which also works from a cached `grok` login, no key
needed) — plus a `./target` repo to edit. Lint them with no agent at all (they
warn that `./target` doesn't exist yet, which is expected — don't add `--strict`,
or that expected warning becomes a non-zero exit):

```bash
loopgen lint examples/ralph-loop.loop.yaml
loopgen lint examples/osmani-harness.batch.yaml
```

## The building blocks

Minimal specs, each isolating one mechanism. The mock ones run offline with no
API key — the fastest way to watch the fail → feedback → fix loop turn over.

| File | Driver | Shows |
| --- | --- | --- |
| [`mock-demo.loop.yaml`](./mock-demo.loop.yaml) | mock (offline) | The core loop end-to-end: a check fails, feedback, then passes |
| [`punch-list.batch.yaml`](./punch-list.batch.yaml) | mock (offline) | A batch with concurrency, distinct workspaces, and a `needs` dependency (inline specs) |
| [`function-fizzbuzz.loop.yaml`](./function-fizzbuzz.loop.yaml) | Claude Agent SDK | A `function` task: implement + tests + typecheck |
| [`api-feature-grok.loop.yaml`](./api-feature-grok.loop.yaml) | grok | An `api` task driven by the grok CLI |
| [`experiment-ab.loop.yaml`](./experiment-ab.loop.yaml) | Claude Agent SDK | An `experiment` task: converge on a metric with the `experiment` evaluator |

```bash
# No API key required:
loopgen run   examples/mock-demo.loop.yaml
loopgen batch examples/punch-list.batch.yaml
```
