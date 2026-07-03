# Observing runs

Evaluators tell you *what* failed; the trace tells you *why the agent didn't
fix it*. Every run can stream its telemetry — loop outcomes plus the agent's
inner trajectory — to a JSONL file, to standard OTLP spans, or to an observer
you write yourself.

## Three layers of evidence

A run produces evidence at three depths. Each answers a different question:

| Layer | What it holds | Question it answers |
|-------|---------------|---------------------|
| **Outcome** | `LoopReport`: outcome, reason, warnings, total usage, overall diff | Did it work, and can I trust the green? |
| **Iteration** | Per-iteration evaluations, changed files, diff stat, stop reason, usage | Which check blocked the loop, and when? |
| **Trajectory** | `AgentEvent` stream: turns, model messages, tool calls/results, errors | What was the agent actually *doing* in there? |

The first two layers have always been in the report (`--report run.json`).
Observability adds the third: drivers emit a vendor-neutral event stream from
inside each `driver.run()`, and the engine forwards it tagged with the run id
and iteration. The forwarding is crash-proof — a throwing sink can never fail
an iteration.

## The quickest path: `--trace`

```bash
loopgen run my.loop.yaml --trace run-trace.jsonl
```

Writes a JSONL execution trace — one JSON object per line, in five record
kinds: `run.start`, `agent.event`, `iteration.end`, `signal`, `run.end`.
Trust-guard warnings become `signal` records (deduplicated, iteration scope
preferred over run scope), so a suspicious green is visible in the trace, not
just the terminal. Works offline:

```bash
npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml --trace trace.jsonl
```

## Observers in the spec

For anything beyond a one-off file, declare observers in the spec. An
**Observer** is the fourth plug-in point, alongside drivers, evaluators, and
task types: a named, spec-referenceable consumer of a run's telemetry.
Resolution mirrors the other plug-ins (`uses` / `as` / `options`):

```yaml
observability:
  observers:
    - uses: jsonl
      options: { file: trace.jsonl }
    - uses: otlp
      options:
        file: trace.otlp.json
        endpoint: http://localhost:4318/v1/traces
```

Observer guarantees, in the same spirit as the trust guards:

- Observers **never change success or failure** — every hook is isolated, so a
  broken observer degrades telemetry but never fails a run.
- Observers are **preflighted** — bad options fail before any agent budget is
  spent.
- `onRunEnd` may be async and is awaited, so a network export can flush before
  the run resolves — and it fires on *every* terminal outcome, not just
  success.
- The block is optional and non-strict: existing specs are unaffected.

## The `jsonl` observer

The offline default: writes the same execution trace as `--trace`, using the
engine's run id as the trace id so the file correlates with the report.

| Option | Default | Meaning |
|--------|---------|---------|
| `file` | `loopgen-trace.jsonl` | Trace file path; relative paths resolve against the run's base dir. |

## The `otlp` observer

Assembles the run into standard OTLP/JSON spans with **zero OpenTelemetry
dependency**. The tree nests four levels — a run root span, an iteration span
per loop iteration, a turn span per agent turn, and a child span per tool call
beneath its turn — with model output on the turn span and warnings as span
events. Drivers that emit no turn detail simply produce a flatter tree (tools
hang directly off the iteration).

| Option | Default | Meaning |
|--------|---------|---------|
| `file` | `loopgen-trace.otlp.json` | Output file; relative paths resolve against the run's base dir. |
| `serviceName` | `loop-generator` | `service.name` resource attribute on the emitted spans. |
| `endpoint` | — | OTLP/HTTP traces URL to POST the spans to, used verbatim (e.g. `http://localhost:4318/v1/traces`). Falls back to the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` env vars; no endpoint means file-only. |
| `headers` | — | Extra HTTP headers for the export (e.g. an auth token / write key). |
| `timeoutMs` | `10000` | Abort the export POST after this many ms. |

Because the output is plain OTLP, it lands anywhere OTLP lands: Jaeger, Grafana
Tempo, Honeycomb, an agent-trace debugger like Raindrop Workshop, or your own
collector. The tool is vendor-neutral by design — bring your own tracing.

## Driver event fidelity

Drivers emit whatever their backend exposes and skip what they can't observe —
honesty over uniformity. What you'll see per driver today:

| Driver | Trajectory detail |
|--------|-------------------|
| `claude-agent-sdk` | **Fine-grained, live.** Model messages, tool calls and results — each stamped with its agent turn, so the OTLP tree nests run → iteration → turn → tool. |
| `github-copilot` | Coarser post-parse trajectory; model output is turn-tagged, so it gets turn spans. |
| `grok` | Coarse post-parse trajectory + errors; no turn detail, so its spans stay flat on the iteration. |
| `opencode` | Coarse post-parse trajectory + errors. |
| `mock` | No agent events — traces carry the loop-level records only (which is why the offline demo's trace has no tool calls). |

## Writing an observer

Implement `Observer`: `begin(info)` returns a per-run session with any of three
optional hooks. Register it like any other plug-in.

```ts
import { type Observer, createDefaultRegistries, LoopEngine } from "loop-generator";

const slack: Observer = {
  name: "slack",
  begin({ runId, spec, log }) {
    return {
      onIteration(report) { /* per-iteration report */ },
      onAgentEvent(event, { iteration }) { /* live trajectory */ },
      async onRunEnd(report) {
        // awaited by the engine — safe to flush a network export
        await postToSlack(`${spec.name}: ${report.outcome}`);
      },
    };
  },
};

const registries = createDefaultRegistries();
registries.observers!.register(slack); // always present from createDefaultRegistries; the field is optional on the type
const engine = new LoopEngine(registries);
```

Hooks must be side-effect-only and non-throwing; the engine isolates every call
regardless. An optional `preflight` validates options before the run spends
anything.

## Library seams

Embedding the engine instead of running the CLI? Two lower-level seams:

- **`RunOptions.onAgentEvent`** — a direct callback for every driver event,
  tagged `{ runId, iteration }`. This is what observers are built on.
- **`runWithTrace()` / `createTraceRecorder()`** — the Stage-1 recorder behind
  `--trace`, exported with `jsonlFileSink` and `arraySink`. It composes with
  any callbacks you already pass.

The source of truth is the code: `src/observers/types.ts` (the contract),
`src/observability/` (the trace model), `src/drivers/types.ts` (`AgentEvent`).
