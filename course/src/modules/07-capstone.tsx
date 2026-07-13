import { useState } from "react";
import { Callout, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";

const OUTCOMES = [
  "success",
  "max-iterations",
  "preflight-failed",
  "aborted",
  "error",
  "baseline-vacuous",
  "spec-tampered",
  "evaluator-tampered",
  "budget-exceeded",
] as const;

interface Prediction {
  id: string;
  scenario: string;
  answer: (typeof OUTCOMES)[number];
  explain: string;
}

const PREDICTIONS: Prediction[] = [
  {
    id: "p1",
    scenario:
      "limits: { baseline: \"strict\" }. The two command checks both exit 0 during the baseline evaluation, before the agent runs.",
    answer: "baseline-vacuous",
    explain:
      "Strict baseline turns 'checks pass before any work' into a hard failure, before a single agent token is spent. With baseline: true it would only be a warning.",
  },
  {
    id: "p2",
    scenario:
      "specGuard: \"error\", spec inside the workspace. Iteration 2 satisfies all-pass, but the spec file's hash no longer matches the one recorded at start.",
    answer: "spec-tampered",
    explain:
      "On the success path the engine re-hashes watched files. specGuard: error converts the apparent green into spec-tampered with success: false.",
  },
  {
    id: "p3",
    scenario:
      "maxCostUsd: 1.00. Iteration 1 costs $0.80 and fails the checks. Iteration 2 costs $0.40 and PASSES all checks (total $1.20).",
    answer: "success",
    explain:
      "A satisfied iteration returns success before the budget ceiling is consulted. Budgets stop further spending after non-converging iterations; they never revoke a result already achieved.",
  },
  {
    id: "p4",
    scenario:
      "driver.uses: \"claud-agent-sdk\" (note the typo). The workspace and evaluators are all valid.",
    answer: "error",
    explain:
      "Plug-in resolution happens up front, before preflight: an unknown driver name throws during registry lookup and the run returns outcome error with the registry's message. (`loopgen lint` would have caught the typo statically via SPEC-DRIVER-UNKNOWN — but that rule isn't part of the engine's run-path preflight, so inside a run it's the registry lookup that fails.)",
  },
  {
    id: "p5",
    scenario:
      "evaluatorGuard: \"error\". The check is `npx vitest run test/auth.test.ts`. The agent rewrites test/auth.test.ts into `expect(true).toBe(true)` and everything passes on iteration 1.",
    answer: "evaluator-tampered",
    explain:
      "test/auth.test.ts is named in the command and test-like, so it was hash-watched at run start. The rewrite flips the hash; with error mode, the green becomes evaluator-tampered.",
  },
  {
    id: "p6",
    scenario:
      "maxIterations: 3 (all defaults otherwise). The agent makes real changes every iteration but the same integration test keeps failing through iteration 3.",
    answer: "max-iterations",
    explain:
      "The iteration budget exhausts without the criteria ever being satisfied: outcome max-iterations, with the last feedback's reason embedded and every iteration's evaluations preserved for debugging.",
  },
];

function PredictionGame() {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const answered = Object.keys(picks).length;
  const right = PREDICTIONS.filter((p) => picks[p.id] === p.answer).length;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Predict the outcome</h3>
      <p style={{ fontSize: 14, color: "var(--muted)" }}>
        Read each run description, then pick which of the nine outcomes the engine reports.{" "}
        {answered > 0 && (
          <strong style={{ color: right === answered ? "var(--green)" : "var(--amber)" }}>
            {right}/{answered} correct so far.
          </strong>
        )}
      </p>
      {PREDICTIONS.map((p) => {
        const pick = picks[p.id];
        return (
          <div key={p.id} className={`sort-item ${pick ? (pick === p.answer ? "judged-right" : "judged-wrong") : ""}`}>
            <div style={{ fontSize: 14 }}>{p.scenario}</div>
            {!pick ? (
              <div className="pill-row" style={{ marginTop: 10 }}>
                {OUTCOMES.map((o) => (
                  <button key={o} className="pill" onClick={() => setPicks({ ...picks, [p.id]: o })}>
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 14 }}>
                <span className={`outcome-chip ${pick === p.answer ? "good" : "bad"}`}>you: {pick}</span>
                {pick !== p.answer && <span className="outcome-chip good">actual: {p.answer}</span>}
                <div style={{ marginTop: 6 }}>{p.explain}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Capstone() {
  return (
    <div>
      <Section title="Part 1 — Predict the outcome">
        <PredictionGame />
      </Section>

      <Section title="Part 2 — Final exam">
        <Callout title="Passing bar" kind="info">
          70% marks the module complete, but you're aiming for expertise — anything you miss, the
          explanation points back at the module to revisit.
        </Callout>
        <Quiz
          moduleId="capstone"
          title="Final exam"
          questions={[
            {
              q: "Trace the data flow after an iteration's evaluators finish. Which order is correct?",
              options: [
                "buildFeedback → evaluateCriteria → agent",
                "evaluateCriteria → buildFeedback → (if not satisfied) that feedback becomes iteration N+1's prompt",
                "evaluateCriteria → agent → buildFeedback",
                "buildFeedback → agent → evaluateCriteria",
              ],
              answer: 1,
              explain:
                "Criteria first (produces the verdict + reason), then buildFeedback renders verdict + diff + failing/passing checks; if not satisfied, buildIterationPrompt wraps that text as the next prompt. (Module 3, 4)",
            },
            {
              q: "Why is 'the run evaluated the original in-memory spec' an important property of the spec guard?",
              options: [
                "It saves a disk read per iteration",
                "Mid-run spec edits can't change THIS run's success criteria — tampering can only target the next run, which the hash-watch then flags",
                "It lets the agent safely refactor the spec",
                "It enables spec hot-reloading",
              ],
              answer: 1,
              explain:
                "The engine parses the spec once and never re-reads it. So the tamper window is only future runs — and the recorded hash plus the terminal-path re-check closes that window. (Module 5)",
            },
            {
              q: "A green run carries: 'criteria satisfied but the agent changed no files' AND the baseline had already passed. Most likely explanation?",
              options: [
                "The agent is exceptionally efficient",
                "Your checks don't verify the new requirement — they were green before and after zero work",
                "Change detection is broken",
                "The driver crashed silently",
              ],
              answer: 1,
              explain:
                "Green-before-work + green-after-no-work is the vacuous-checks signature. The fix is a check that is RED until the requirement is met — not a bigger iteration budget. (Modules 3, 5, 6)",
            },
            {
              q: "Which statement about budgets is FALSE?",
              options: [
                "maxTokens counts input + output combined",
                "A driver reporting no usage can never trip a budget",
                "The budget check runs before each iteration starts, so an over-budget iteration never runs",
                "Cost is checked before tokens",
              ],
              answer: 2,
              explain:
                "The check runs AFTER a non-converging iteration — so one iteration can overshoot the cap before the loop stops. The other three are true. (Module 3)",
            },
            {
              q: "You must let the agent ADD tests but not MODIFY the existing contract suite in test/contract/. Best configuration?",
              options: [
                "evaluatorGuard: \"off\" — get out of the agent's way",
                "guard: [\"test/contract/\"] on the check + evaluatorGuard: \"error\" — watch that directory, leave new test files unguarded",
                "workspace.ignore: [\"test/**\"]",
                "prompts.system: \"do not edit contract tests\"",
              ],
              answer: 1,
              explain:
                "Explicit directory guards watch recursively; files elsewhere (the agent's new tests) stay unwatched, so legitimate test-adding isn't flagged. A prompt rule alone is a request, not a control. (Modules 5, 6)",
            },
            {
              q: "Which run CANNOT produce outcome 'error'?",
              options: [
                "Unknown driver.uses name",
                "taskType.validate returning errors",
                "An evaluator throwing during iteration 2",
                "The observer registry missing while the spec declares an observer",
              ],
              answer: 2,
              explain:
                "A throwing evaluator is converted into a failed EvaluationResult (ok: false) and the loop continues — it can lead to max-iterations, never directly to error. The other three all fail during up-front resolution/validation. (Module 3)",
            },
            {
              q: "The deepest reason the loop works at all — the property everything else protects — is:",
              options: [
                "The agent's intelligence",
                "Prompt engineering in the task types",
                "Falsifiable, hard-to-fake measurements whose failures are actionable — the loop converges on whatever the evaluators actually measure",
                "The zod schema's strictness",
              ],
              answer: 2,
              explain:
                "The loop optimizes the agent against the evaluators — Goodhart in your favor. If they measure the requirement, iteration converges on the requirement; if they measure a proxy, it converges on the proxy. Guards, baselines, and diffs exist to keep that measurement honest. (Every module)",
            },
          ]}
        />
      </Section>

      <div className="complete-banner">
        <span style={{ fontSize: 26 }}>🏁</span>
        <div>
          <strong>Where to go next:</strong> run the offline demo (
          <code>npm run loopgen -- run examples/building-blocks/mock-demo.loop.yaml</code>, from the repo
          root), author a real
          loop with the <code>author-loop</code> skill, then read <code>src/core/engine.ts</code> top to
          bottom — after this course, it reads like the course did.
        </div>
      </div>
    </div>
  );
}
