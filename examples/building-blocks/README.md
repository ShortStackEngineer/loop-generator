# Building blocks

Minimal specs, each isolating one mechanism — the drivers, the `function` / `api`
/ `experiment` task types, and a batch run. Start with `mock-demo`, which runs
offline with no API key. From the repo root:

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml
```

The rest are agent-driven and point at your own repo (`workspace.dir`); with no
API key you can still `npm run loopgen -- lint` them. See the
[examples index](../README.md#building-blocks) for what each spec shows.
