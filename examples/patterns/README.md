# Loop patterns

Established agent-looping patterns expressed as loop-generator specs, with the
trust guards on: the Ralph Wiggum loop, the evaluator-optimizer, and Osmani's
discover → implement → verify harness (whose stage specs live in
[`osmani-harness/`](./osmani-harness)).

These drive a real agent against your own repo, so a full run needs a driver and
credentials — but you can lint any of them with no agent, from the repo root:

```bash
npm run loopgen -- lint examples/patterns/ralph-loop.loop.yaml
```

See the [examples index](../README.md#loop-patterns) for what each one does and
what the declarative version adds.
