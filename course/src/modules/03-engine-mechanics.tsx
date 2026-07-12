import { Callout, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";
import { SimPlayer } from "../components/SimPlayer";
import { SCENARIOS } from "../sim/engine";

export function EngineMechanics() {
  return (
    <div>
      <Section title="The control flow, in one breath">
        <p>
          <code>LoopEngine.run()</code> does exactly this: resolve plug-ins (fail fast on typos) →
          preflight (workspace lint, driver, evaluators, observers) → optional baseline eval → then per
          iteration: build the prompt → drive the agent → snapshot &amp; diff the workspace → run
          evaluators → <code>evaluateCriteria</code> → if satisfied, return; else{" "}
          <code>buildFeedback</code> and go again — until <code>maxIterations</code> or a budget stops
          it. Every exit path re-checks the tamper guards and returns one of the nine outcomes.
        </p>
      </Section>

      <Section title="Step through real runs">
        <p>
          Six scenarios, six outcomes. Step through each one — the right-hand pane explains the engine
          mechanics behind every phase.
        </p>
        <SimPlayer scenarios={SCENARIOS} />
      </Section>

      <Section title="Details experts know">
        <Callout title="Change detection has a fallback chain" kind="info">
          Git tree diff (throwaway index — your real index is never touched) → content-hash walk (when
          the workspace isn't a usable git repo; capped file count, no unified diff) → driver
          self-report (only trusted when the content walk hit its cap). A fabricating driver can't
          silence the vacuous-success guard: an unverifiable "I changed files" claim is ignored.
        </Callout>
        <Callout title="Session resume" kind="info">
          The engine passes the previous iteration's <code>sessionId</code> back to the driver as{" "}
          <code>resumeSessionId</code>. Drivers <em>opt in</em> to resuming (useful after a{" "}
          <code>max_turns</code> stop); the engine only offers.
        </Callout>
        <Callout title="Honest warnings on green runs" kind="warn">
          A satisfied verdict where the agent stopped with <code>max_turns</code> or <code>error</code>{" "}
          still succeeds — but carries "success rests on the checks alone". Where checks are strong
          that's fine; where they're weak, it's your cue to look.
        </Callout>
        <Callout title="Evaluator crashes are results, not exceptions" kind="info">
          A throwing evaluator becomes <code>{`{ ok: false, passed: false, feedback: "Evaluator threw: …" }`}</code>.
          The loop keeps going and the agent sees the error as feedback. <code>ok: false</code> means
          "the measurement itself failed", distinct from "the code failed the measurement".
        </Callout>
      </Section>

      <Quiz
        moduleId="engine-mechanics"
        questions={[
          {
            q: "Iteration 3 satisfies the criteria, but cumulative cost is already over limits.maxCostUsd. Outcome?",
            options: [
              "budget-exceeded — the cap is absolute",
              "success — a satisfied iteration returns before the budget check",
              "success, but with success: false in the report",
              "max-iterations",
            ],
            answer: 1,
            explain:
              "The budget ceiling is evaluated only after a NON-converging iteration. Getting the result is never penalized; the cap exists to stop funding further turns. So a green iteration over budget still returns success.",
          },
          {
            q: "The workspace isn't a git repo and the driver reports changedFiles: [\"a.ts\"], but the content-hash walk (under its file cap) saw no changes. What does the engine record?",
            options: [
              "changed: true — the driver is authoritative",
              "changed: false — the unverified driver claim is ignored so it can't silence the vacuous guard",
              "The run aborts with error",
              "changed: true, with a warning",
            ],
            answer: 1,
            explain:
              "Content-hash detection is authoritative under the cap. The driver's self-report is only trusted when the walk may have missed files (cap hit) — and even then it's flagged as unverified. A fabricating driver can't fake work.",
          },
          {
            q: "When does the engine run driver.preflight and evaluator preflights?",
            options: [
              "Before every iteration",
              "Once, before any agent work — a failure ends the run as preflight-failed",
              "Only when --verify-driver is passed",
              "Lazily, on first use of each plug-in",
            ],
            answer: 1,
            explain:
              "Preflight happens once per run, before the baseline and before any tokens are spent: workspace lint rules marked preflight: true, then driver, evaluators, and observers. Any error → outcome preflight-failed.",
          },
          {
            q: "An observer's onIteration throws on every call. Effect on the run?",
            options: [
              "The run fails with outcome error",
              "The iteration is retried without observers",
              "None on the outcome — the hook is isolated; telemetry just degrades",
              "The observer is re-initialized",
            ],
            answer: 2,
            explain:
              "Observers can never affect outcomes: begin, onIteration, onAgentEvent, and onRunEnd are all individually try/caught. A broken observer costs you telemetry, nothing else.",
          },
          {
            q: "What is the engine's snapshotTree careful NOT to do?",
            options: [
              "Hash files over 1 MB",
              "Touch your real git index — it uses a throwaway index file",
              "Run on Windows",
              "Include untracked files",
            ],
            answer: 1,
            explain:
              "Snapshots are taken via a throwaway git index so the run can diff the tree (including untracked files) without ever disturbing your actual index or staging area.",
          },
          {
            q: "Which outcome CANNOT carry success: true?",
            options: ["success", "Any of the other eight", "aborted", "max-iterations"],
            answer: 1,
            explain:
              "Exactly one outcome means success. Even spec-tampered/evaluator-tampered runs where criteria passed report success: false — a green from an agent that rewrote its contract doesn't count.",
          },
        ]}
      />
    </div>
  );
}
