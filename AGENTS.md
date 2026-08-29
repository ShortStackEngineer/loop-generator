# AGENTS.md

## Cursor Cloud specific instructions

`loop-generator` is a pure TypeScript/Node CLI + library (the `loopgen` binary).
There is no server, database, or other long-running service to start — the
"application" is the CLI, and it runs fully offline. Node ≥ 20 is required
(CI uses Node 22); this VM already has Node 22.

Standard dev commands live in `package.json` scripts and are documented in
`README.md` (Development section) and `CLAUDE.md` (Commands section). Use
`npm run typecheck`, `npm test`, `npm run build`, and `npm run dev -- <args>`
(source CLI via tsx). After `npm run build`, the built binary is
`node dist/cli/index.js <args>`.

Non-obvious notes:

- There is no ESLint/source linter. "Lint" in this repo refers to the app's own
  spec linter, `loopgen lint <file>.loop.yaml`, which statically validates a
  `.loop.yaml` before any agent turn — not linting of the TypeScript source.
- The offline smoke path needs no API key: it uses the scripted `mock` driver.
  Run it with `node dist/cli/index.js run examples/building-blocks/mock-demo.loop.yaml`
  (or `npm run dev -- run ...`). This is the canonical end-to-end check.
- Real agent drivers (`claude-agent-sdk`, `grok`, `github-copilot`, `opencode`)
  are optional and require credentials/CLIs that are NOT installed here
  (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, or the respective CLIs). Everything else —
  typecheck, the full test suite, build, lint, and the mock loop — runs offline.
- Running an example spec creates a gitignored workspace next to the spec
  (e.g. `examples/**/.workspace/`, `examples/**/target/`); this is expected and
  safe to leave.
- A few tests intentionally exercise command timeouts and take ~5–10s each, so
  the suite takes ~15–30s overall. That is normal, not a hang.
- `npm run coverage` (85% lines/functions/statements, 80% branches) and
  `npm run mutation` (Stryker) are the CI gates; the plain `npm test` is the
  fast inner loop.
- **In-repo loops** live under `loops/` — archetype templates (`bug`, `greenfield`,
  `refactor`), `loops/invariants/regression.loop.yaml`, and per-ticket specs in
  `loops/instances/`. Scaffold with `./loops/new <kind> <slug>`; see `loops/README.md`.
