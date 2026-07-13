import { useState } from "react";
import { Callout, Code, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";

interface Part {
  id: string;
  title: string;
  color: string;
  body: string;
}

const PARTS: Part[] = [
  {
    id: "spec",
    title: "LoopSpec (.loop.yaml)",
    color: "var(--accent2)",
    body:
      "The declarative artifact everything starts from: a task, a stack, an agent backend (driver), the tools that measure success (evaluators), success criteria, and limits. It's parsed and validated by a zod schema (src/core/spec.ts). Plug-ins are referenced as plain strings (driver.uses, evaluators[].uses, task.type) resolved against registries at run time — the schema never changes when you add a plug-in.",
  },
  {
    id: "engine",
    title: "LoopEngine",
    color: "var(--accent)",
    body:
      "The whole control flow lives in src/core/engine.ts: resolve plug-ins → preflight → optional baseline eval → per-iteration loop (drive agent → snapshot/diff the workspace → run evaluators → evaluateCriteria → buildFeedback) → terminal report. It is deliberately small; everything interesting is a plug-in.",
  },
  {
    id: "driver",
    title: "AgentDriver",
    color: "var(--green)",
    body:
      "The coding agent, behind a uniform contract (src/drivers/types.ts): name, optional preflight, and run(invocation) → AgentRunResult. Built-ins: mock (scripted, for offline runs and tests), claude-agent-sdk, grok, github-copilot, opencode. The stopReason (completed | max_turns | aborted | error) lets the engine attach honest warnings to green runs where the agent didn't actually finish.",
  },
  {
    id: "evaluators",
    title: "Evaluator[]",
    color: "var(--purple)",
    body:
      "The feedback tools: measure the workspace, return passed + actionable feedback (src/evaluators/types.ts). Built-ins: command (any CLI with an exit code — test runners, type checkers, linters, benchmarks) and experiment (numeric metric vs threshold/baseline). These are the loop's only sensors: the run is exactly as trustworthy as they are.",
  },
  {
    id: "task",
    title: "TaskType",
    color: "var(--red)",
    body:
      "Prompt scaffolding per task category (function, api, webapp, experiment, generic): a role, category guidance, and recommended evaluators. Advisory: an unregistered task.type silently falls back to genericTask, so it never breaks a run.",
  },
  {
    id: "observers",
    title: "Observer[]",
    color: "var(--muted)",
    body:
      "Run telemetry (jsonl trace, OTLP spans). Strictly read-only with respect to outcomes: every hook is isolated, and a broken observer degrades telemetry only — it can never fail a run.",
  },
];

function Diagram(props: { selected: string; onSelect: (id: string) => void }) {
  const sel = (id: string) => (props.selected === id ? 1 : 0.35);
  return (
    <svg viewBox="0 0 720 300" style={{ width: "100%", maxWidth: 720 }}>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      {/* spec */}
      <g className="hotspot" opacity={sel("spec")} onClick={() => props.onSelect("spec")}>
        <rect x="10" y="110" width="150" height="60" rx="10" fill="none" stroke="var(--accent2)" strokeWidth="2" />
        <text x="85" y="136" textAnchor="middle" fill="var(--accent2)" fontSize="14" fontWeight="700">LoopSpec</text>
        <text x="85" y="155" textAnchor="middle" fill="var(--muted)" fontSize="11">.loop.yaml</text>
      </g>
      <line x1="160" y1="140" x2="215" y2="140" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
      {/* engine */}
      <g className="hotspot" opacity={sel("engine")} onClick={() => props.onSelect("engine")}>
        <rect x="220" y="95" width="180" height="90" rx="10" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        <text x="310" y="130" textAnchor="middle" fill="var(--accent)" fontSize="15" fontWeight="700">LoopEngine</text>
        <text x="310" y="150" textAnchor="middle" fill="var(--muted)" fontSize="11">drive → measure → feed back</text>
        <text x="310" y="166" textAnchor="middle" fill="var(--muted)" fontSize="11">until success or budget out</text>
      </g>
      {/* plug points */}
      <line x1="400" y1="115" x2="465" y2="45" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
      <line x1="400" y1="135" x2="465" y2="125" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
      <line x1="400" y1="160" x2="465" y2="200" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
      <line x1="310" y1="185" x2="310" y2="245" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
      <g className="hotspot" opacity={sel("driver")} onClick={() => props.onSelect("driver")}>
        <rect x="470" y="20" width="230" height="50" rx="10" fill="none" stroke="var(--green)" strokeWidth="2" />
        <text x="585" y="42" textAnchor="middle" fill="var(--green)" fontSize="13" fontWeight="700">AgentDriver</text>
        <text x="585" y="58" textAnchor="middle" fill="var(--muted)" fontSize="10.5">the coding agent (mock, claude-agent-sdk…)</text>
      </g>
      <g className="hotspot" opacity={sel("evaluators")} onClick={() => props.onSelect("evaluators")}>
        <rect x="470" y="100" width="230" height="50" rx="10" fill="none" stroke="var(--purple)" strokeWidth="2" />
        <text x="585" y="122" textAnchor="middle" fill="var(--purple)" fontSize="13" fontWeight="700">Evaluator[]</text>
        <text x="585" y="138" textAnchor="middle" fill="var(--muted)" fontSize="10.5">the feedback tools (command, experiment)</text>
      </g>
      <g className="hotspot" opacity={sel("task")} onClick={() => props.onSelect("task")}>
        <rect x="470" y="178" width="230" height="50" rx="10" fill="none" stroke="var(--red)" strokeWidth="2" />
        <text x="585" y="200" textAnchor="middle" fill="var(--red)" fontSize="13" fontWeight="700">TaskType</text>
        <text x="585" y="216" textAnchor="middle" fill="var(--muted)" fontSize="10.5">prompt scaffolding (function, api, webapp…)</text>
      </g>
      <g className="hotspot" opacity={sel("observers")} onClick={() => props.onSelect("observers")}>
        <rect x="195" y="250" width="230" height="44" rx="10" fill="none" stroke="var(--muted)" strokeWidth="2" />
        <text x="310" y="269" textAnchor="middle" fill="var(--text)" fontSize="13" fontWeight="700">Observer[]</text>
        <text x="310" y="285" textAnchor="middle" fill="var(--muted)" fontSize="10.5">telemetry only — can never affect the outcome</text>
      </g>
    </svg>
  );
}

export function BigPicture() {
  const [selected, setSelected] = useState("engine");
  const part = PARTS.find((p) => p.id === selected)!;

  return (
    <div>
      <Section title="What problem does this solve?">
        <p>
          Ask a coding agent to “implement X and make sure it works” and you get one shot: the agent
          claims success, and you do the verifying. <code>loop-generator</code> inverts that. You write
          down <em>how success is measured</em> — commands with exit codes, metrics with thresholds —
          and the engine invokes the agent, runs those measurements, folds the results into feedback,
          and re-invokes. The loop ends when the measurements pass or a budget runs out.
        </p>
        <Callout title="The core idea">
          The unit of reuse is the <strong>spec</strong>, not the prompt. A <code>.loop.yaml</code> is a
          reusable, declarative contract: task + stack + agent backend + measurement tools + success
          criteria + limits. Generate it once (<code>loopgen generate</code>), run it against any
          registered agent backend (<code>loopgen run -d claude-agent-sdk</code> or <code>-d mock</code>).
        </Callout>
      </Section>

      <Section title="Explore the architecture (click each part)">
        <div className="card">
          <Diagram selected={selected} onSelect={setSelected} />
          <div className="diagram-detail">
            <h3 style={{ color: part.color }}>{part.title}</h3>
            <p style={{ fontSize: 14.5 }}>{part.body}</p>
          </div>
        </div>
        <Callout title="Registries: how plug-ins stay decoupled" kind="info">
          <code>Registry&lt;T&gt;</code> is a typed name→plug-in map. <code>createDefaultRegistries()</code>{" "}
          wires the built-ins; the engine takes registries as a constructor argument. Adding a driver or
          evaluator is <em>register-and-pass</em> — you never edit the engine.
        </Callout>
      </Section>

      <Section title="One loop, end to end">
        <Code>{`$ loopgen run task.loop.yaml
engine  workspace: /work/my-app
engine  running baseline evaluation (no agent) …
iter0   starting iteration 1/5
iter0   result: not yet — failing: tests
iter1   starting iteration 2/5
iter1   result: PASS — all checks passed
outcome: success (2 iterations)`}</Code>
        <p>
          Every run ends with a <code>LoopReport</code> whose <code>outcome</code> is one of exactly nine
          values — this list is the canonical map of how a run can end, and you will meet each one in
          Module 3:
        </p>
        <p>
          <span className="outcome-chip good">success</span>
          <span className="outcome-chip bad">max-iterations</span>
          <span className="outcome-chip bad">preflight-failed</span>
          <span className="outcome-chip warn">aborted</span>
          <span className="outcome-chip bad">error</span>
          <span className="outcome-chip bad">baseline-vacuous</span>
          <span className="outcome-chip bad">spec-tampered</span>
          <span className="outcome-chip bad">evaluator-tampered</span>
          <span className="outcome-chip bad">budget-exceeded</span>
        </p>
      </Section>

      <Quiz
        moduleId="big-picture"
        questions={[
          {
            q: "A spec references task.type: \"data-pipeline\", which is not registered. What happens?",
            options: [
              "The run fails at preflight with an unknown-task error",
              "The run proceeds using the generic task type's prompt scaffolding",
              "The engine asks the driver to pick the closest task type",
              "The spec fails zod validation",
            ],
            answer: 1,
            explain:
              "TaskType is advisory: an unregistered task.type falls back to genericTask so it never breaks a run. Contrast with driver.uses and evaluators[].uses — a typo in those fails fast when plug-ins are resolved.",
          },
          {
            q: "Which plug-in point is guaranteed to never change a run's outcome?",
            options: ["AgentDriver", "Evaluator", "TaskType", "Observer"],
            answer: 3,
            explain:
              "Observers are telemetry only. Every observer hook is isolated in try/catch; a broken observer degrades telemetry, never the run. Evaluators literally decide the outcome, drivers do the work, and task types shape prompts.",
          },
          {
            q: "What makes a .loop.yaml schema-stable when new drivers or evaluators are added?",
            options: [
              "The schema uses catchall(unknown) for everything",
              "Plug-ins are referenced as plain strings resolved against registries at run time",
              "Each plug-in ships its own schema extension",
              "New plug-ins require a version bump in the spec",
            ],
            answer: 1,
            explain:
              "driver.uses, evaluators[].uses, and task.type are intentionally plain strings resolved against registries. Adding a plug-in is register-and-pass — neither the schema nor the engine changes.",
          },
          {
            q: "Which pair correctly names the two built-in evaluators?",
            options: [
              "command and experiment",
              "test and metric",
              "shell and llm-judge",
              "pytest and vitest",
            ],
            answer: 0,
            explain:
              "command runs any CLI and treats its exit code (and optional parsed score) as signal; experiment reads a numeric metric from JSON and compares to thresholds/baseline. Everything — tests, type checks, lints, benchmarks — is expressed through these two.",
          },
        ]}
      />
    </div>
  );
}
