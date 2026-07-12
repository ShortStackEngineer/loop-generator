import { useEffect, useRef, useState } from "react";
import type { Scenario } from "../sim/engine";

/** Step-through player for a scripted engine scenario. */
export function SimPlayer(props: { scenarios: Scenario[] }) {
  const [scenarioId, setScenarioId] = useState(props.scenarios[0]?.id ?? "");
  const [step, setStep] = useState(0);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  const scenario = props.scenarios.find((s) => s.id === scenarioId) ?? props.scenarios[0];

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight, behavior: "smooth" });
  }, [step, scenarioId]);

  if (!scenario) return null;
  const shown = scenario.steps.slice(0, step);
  const done = step >= scenario.steps.length;
  const currentExplain = step > 0 ? scenario.steps[step - 1]?.explain : undefined;

  return (
    <div className="card">
      <div className="pill-row">
        {props.scenarios.map((s) => (
          <button
            key={s.id}
            className={`pill ${s.id === scenario.id ? "on" : ""}`}
            onClick={() => {
              setScenarioId(s.id);
              setStep(0);
            }}
          >
            {s.title}
          </button>
        ))}
      </div>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>{scenario.description}</p>
      <div className="btn-row">
        <button className="btn" disabled={done} onClick={() => setStep((s) => s + 1)}>
          {step === 0 ? "▶ Start run" : done ? "Run finished" : `Step ${step + 1} of ${scenario.steps.length}: ${scenario.steps[step]?.label ?? ""}`}
        </button>
        <button className="btn secondary" disabled={step === 0} onClick={() => setStep(0)}>
          Reset
        </button>
        {done && (
          <span className={`outcome-chip ${scenario.outcomeKind}`}>{scenario.outcome}</span>
        )}
      </div>
      <div className="two-col">
        <div className="sim-console" ref={consoleRef}>
          {shown.length === 0 && <div className="sim-line dim">Press “Start run” to step through the engine…</div>}
          {shown.map((st, i) => (
            <div key={i}>
              {st.lines.map((l, j) => (
                <div key={j} className={`sim-line ${l.cls}`}>
                  {l.text}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="diagram-detail">
          {currentExplain ? (
            <div className="callout" style={{ margin: 0 }}>
              <div className="callout-title">What just happened</div>
              {currentExplain}
            </div>
          ) : (
            <div className="callout" style={{ margin: 0 }}>
              <div className="callout-title">How to use this</div>
              Pick a scenario, then step through the run one engine phase at a time. The left pane is the
              engine's log; this pane explains the mechanics behind each step.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
