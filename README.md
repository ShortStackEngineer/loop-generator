# loop-generator

Generate and run **agent coding feedback loops**. You describe a task, the stack,
and the tools that measure success; the generator emits a reusable spec; the
runner invokes a coding agent and re-invokes it — feeding back the measurement
results each time — until the goal is met or the iteration budget runs out.

```
LoopSpec (.loop.yaml) ──► LoopEngine ──► loop until success / maxIterations
                            │
        ┌───────────────────┼─────────────────────────┐
        ▼                   ▼                          ▼
   AgentDriver         Evaluator[]                 TaskType
  (the coding agent)  (the feedback tools)     (prompt scaffolding per category)
```

Each iteration: **drive the agent → run the evaluators → check success criteria →
fold the results into feedback → repeat.**

## Concepts

| Piece | What it is | Built-ins |
|-------|-----------|-----------|
| **Driver** | Wraps a coding agent behind one interface | `claude-agent-sdk`, `mock` |
| **Evaluator** | A "feedback tool" that measures the workspace and returns pass/fail + actionable feedback | `command`, `experiment` |
| **Task type** | Category knowledge: how to frame/instruct the agent and which evaluators to scaffold | `function`, `api`, `webapp`, `experiment`, `generic` |
| **Success criteria** | Declarative rule over evaluator results | `all-pass`, `pass`, `score`, `all`/`any`/`not` |

The generic `command` evaluator already covers **tests, linters, type checkers,
and benchmarks** — anything with a CLI and an exit code. The `experiment`
evaluator reads a numeric metric (from a command's JSON output or a file) and
compares it to thresholds/baselines, for A/B tests and perf work.

## Install

```bash
npm install
# The Claude Agent SDK is an optional dependency, installed automatically.
# For real agent runs, set credentials:
export ANTHROPIC_API_KEY=...   # or use a Claude login / Bedrock / Vertex
```

## Quick start

Run the **offline demo** (no API key — uses the scripted `mock` driver):

```bash
npm run loopgen -- run examples/mock-demo.loop.yaml
```

Generate a new loop and run it:

```bash
npm run loopgen -- generate -i                 # interactive
npm run loopgen -- run my-loop.loop.yaml
```

List what's registered, or verify a driver:

```bash
npm run loopgen -- list
npm run loopgen -- verify-driver mock
```

(After `npm run build`, the `loopgen` binary is available directly.)

## The spec

```yaml
version: 1
name: add-retry-to-fetchUser
task:
  type: function
stack:
  language: typescript
  packageManager: npm
workspace:
  dir: ./target          # the directory the agent edits (relative to this file)
requirements: |
  Add exponential backoff (max 3 retries) to fetchUser(). Keep the signature.
driver:
  uses: claude-agent-sdk
  options:
    model: claude-opus-4-8
    maxTurns: 30
evaluators:
  - uses: command
    as: tests
    options: { command: npm test }
  - uses: command
    as: typecheck
    options: { command: npx tsc --noEmit }
success:
  type: all-pass         # all evaluators must pass
limits:
  maxIterations: 6
```

See [`examples/`](./examples) for function, experiment/A-B, and offline specs.

## Extending it

The whole system is three plug-in points. Register your own and pass them to the
engine.

### A new evaluator (feedback tool)

```ts
import { type Evaluator } from "loop-generator";

export const coverageEvaluator: Evaluator = {
  type: "coverage",
  async evaluate(ctx) {
    const pct = await measureCoverage(ctx.workdir);   // your logic
    return {
      passed: pct >= 0.9,
      score: pct,
      feedback: `coverage ${(pct * 100).toFixed(1)}% (need ≥ 90%)`,
    };
  },
};
```

### A new driver (agent backend)

Implement `AgentDriver`, then **validate it against the conformance harness** —
the apparatus this project gives you for building new integrations:

```ts
import { runDriverConformance, formatConformanceReport } from "loop-generator/testing";
import { myDriver } from "./my-driver";

const report = await runDriverConformance({ makeDriver: () => myDriver });
console.log(formatConformanceReport(report));   // ✓/✗ per behavioral contract
```

The harness drives your agent against temp workspaces and asserts the contract:
it reports a name, creates a requested file, applies feedback across iterations,
and handles aborts. Prompt-driven drivers (like the Claude SDK) work out of the
box; scripted drivers supply an `optionsFor` mapping. The CLI exposes it too:

```bash
loopgen verify-driver claude-agent-sdk
```

### Use the engine as a library

```ts
import { LoopEngine, createDefaultRegistries, parseSpec } from "loop-generator";

const engine = new LoopEngine(createDefaultRegistries());
const report = await engine.run(parseSpec(spec), { baseDir: process.cwd() });
console.log(report.success, report.reason);
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Status

v1 is the full framework skeleton: a working engine, the three extension points,
the conformance harness, the `mock` + `claude-agent-sdk` drivers, the `command` +
`experiment` evaluators, and four task types. Task types beyond `function` ship
with prompt scaffolding and recommended evaluators; deepen them as you go.
