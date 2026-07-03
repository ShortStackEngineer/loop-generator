# Building blocks

Minimal specs, each isolating one mechanism — the drivers, the `function` / `api`
/ `experiment` task types, observers, and a batch run. Start with `mock-demo`,
which runs offline with no API key; `observed-demo` is the same loop with the
`jsonl` + `otlp` observers attached. From the repo root:

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
npm run loopgen -- run examples/building-blocks/observed-demo.loop.yaml
```

The rest are agent-driven and point at your own repo (`workspace.dir`); with no
API key you can still `npm run loopgen -- lint` them. See the
[examples index](../README.md#building-blocks) for what each spec shows.
