import { useState } from "react";
import { Callout, Code, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";

interface JudgeItem {
  id: string;
  check: string;
  /** true = strong/trustworthy, false = weak/fake-able */
  strong: boolean;
  why: string;
}

const JUDGE_ITEMS: JudgeItem[] = [
  {
    id: "j1",
    check: "command: \"npx vitest run test/rate-limit.test.ts\" — a new integration test that hits the real middleware and asserts 429 + Retry-After on the 101st request. Verified RED before the run.",
    strong: true,
    why:
      "Falsifiable (starts RED for the right reason), exercises the real behavior end-to-end, names the file (so the auto-guard watches it), and a vitest failure message tells the agent exactly what's wrong. This is the author-loop gold standard.",
  },
  {
    id: "j2",
    check: "command: \"test -f src/rate-limit.ts\" — pass if the file exists.",
    strong: false,
    why:
      "Existence isn't behavior: `touch src/rate-limit.ts` satisfies it. Also produces useless feedback (no output on failure). Fine as a scaffolding sanity check, worthless as a success criterion.",
  },
  {
    id: "j3",
    check: "command: \"npm test\" on a repo whose suite was already green, with limits.baseline: false.",
    strong: false,
    why:
      "Without a baseline you never learn the checks passed before any work — the vacuous-success trap. Either enable baseline (ideally strict) or add a check that's RED until the new requirement is met.",
  },
  {
    id: "j4",
    check: "experiment evaluator: metricsFile: \"bench.json\", metric: \"p95Ms\", maxValue: 200 — where bench.json is written by the agent's own code.",
    strong: false,
    why:
      "The agent controls the measurement: nothing stops it writing {\"p95Ms\": 1} directly. Prefer command mode where the EVALUATOR runs the benchmark (`command: \"node bench.js\"` printing JSON to stdout) so the number is produced by the harness at evaluation time, not read from an agent-writable file.",
  },
  {
    id: "j5",
    check: "command: \"npx tsc --noEmit\" as static-check, alongside a behavioral test check.",
    strong: true,
    why:
      "As a supporting check it's excellent: cheap, deterministic, actionable errors, hard to fake without actually fixing types. It only becomes a problem when it's the ONLY check — compiling isn't the requirement.",
  },
  {
    id: "j6",
    check: "command: \"curl -s https://api.example.com/health\" — pass if the production health endpoint returns 200.",
    strong: false,
    why:
      "Depends on external state the agent can't affect from the workspace: flaky network, shared environment, non-reproducible. Evaluators should measure the workspace. If you must, wrap it with a local server started by the check itself.",
  },
  {
    id: "j7",
    check: "command: \"npx vitest run --coverage\" with scoreRegex: \"All files[^\\\\d]*(\\\\d+\\\\.?\\\\d*)\" and scoreGte: 85.",
    strong: true,
    why:
      "The command evaluator's score extraction turns any CLI that prints a number into a threshold gate: exit code must match AND the parsed score must clear scoreGte. Coverage can be gamed with trivial assertions, so pair it with real behavioral checks — but as a floor it's solid and deterministic.",
  },
  {
    id: "j8",
    check: "A single command that runs the entire 25-minute e2e suite, as the only evaluator, with maxIterations: 5.",
    strong: false,
    why:
      "Not wrong, but poorly shaped for a loop: 25 minutes per iteration means feedback arrives five times per two hours. Loops want fast, focused checks — run the narrow slice that pins the requirement each iteration; save the full suite for a final gate (or a batch item that depends on this loop).",
  },
];

function JudgeGame() {
  const [judged, setJudged] = useState<Record<string, boolean>>({});
  const score = JUDGE_ITEMS.filter((i) => judged[i.id] !== undefined && judged[i.id] === i.strong).length;
  const total = Object.keys(judged).length;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Judge the check: trustworthy or fake-able?</h3>
      <p style={{ fontSize: 14, color: "var(--muted)" }}>
        For each check, decide whether you'd trust a green from it. Score: {score}/{total || 0} judged.
      </p>
      {JUDGE_ITEMS.map((item) => {
        const j = judged[item.id];
        const answered = j !== undefined;
        const right = answered && j === item.strong;
        return (
          <div key={item.id} className={`sort-item ${answered ? (right ? "judged-right" : "judged-wrong") : ""}`}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{item.check}</div>
            {!answered ? (
              <div className="btn-row">
                <button className="btn secondary" onClick={() => setJudged({ ...judged, [item.id]: true })}>
                  ✓ Trustworthy
                </button>
                <button className="btn secondary" onClick={() => setJudged({ ...judged, [item.id]: false })}>
                  ✗ Weak / fake-able
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 14 }}>
                <strong style={{ color: right ? "var(--green)" : "var(--red)" }}>
                  {right ? "Correct — " : "Not quite — "}
                  {item.strong ? "this one is trustworthy." : "this one is weak."}
                </strong>{" "}
                {item.why}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EvaluatorDesign() {
  return (
    <div>
      <Section title="The five properties of a good feedback tool">
        <table className="tbl">
          <thead>
            <tr>
              <th>Property</th>
              <th>Meaning</th>
              <th>Mechanism</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Falsifiable</strong></td>
              <td>RED now, for the right reason, before any agent work</td>
              <td>baseline: strict; the author-loop / frame-checks skills exist to prove this</td>
            </tr>
            <tr>
              <td><strong>Actionable</strong></td>
              <td>A failure tells the agent what to fix</td>
              <td>The command's output tail (feedbackChars, default 3000) becomes the prompt — verbose runners beat silent ones</td>
            </tr>
            <tr>
              <td><strong>Hard to fake</strong></td>
              <td>Green requires meeting the requirement</td>
              <td>Exercise behavior, not artifacts; guard the test files; evaluator runs the measurement itself</td>
            </tr>
            <tr>
              <td><strong>Fast</strong></td>
              <td>Feedback per iteration, not per hour</td>
              <td>Narrow slices per loop; full suites as final gates; timeoutMs per check</td>
            </tr>
            <tr>
              <td><strong>Deterministic</strong></td>
              <td>Same workspace ⇒ same verdict</td>
              <td>No external network/state; concurrency: 1 protects shared local state</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title="The command evaluator, completely">
        <Code file="options for uses: command">{`command: "npx vitest run test/slug.test.ts"   # required — any CLI
cwd: "packages/api"        # run in a subdirectory of the workspace
expectExitCode: 0          # what counts as a pass (default 0)
timeoutMs: 120000          # per-command timeout → timeout = FAIL
env: { CI: "1" }           # extra environment variables
feedbackChars: 3000        # tail of output fed back to the agent
scoreRegex: "coverage: (\\\\d+)"  # capture group 1 → numeric score
scoreGte: 85               # pass ALSO requires score in [gte, lte]
scoreLte: 100`}</Code>
        <p>
          Pass = exit code matches <code>expectExitCode</code> AND no timeout AND (if{" "}
          <code>scoreGte</code>/<code>scoreLte</code> set) the parsed score is in range. The score is
          also exposed on the result, so a <code>success: {"{ type: \"score\" … }"}</code> criterion can
          gate on it independently. On failure, the output <em>tail</em> is fed back — test summaries
          live at the end of output.
        </p>
        <Callout title="One evaluator, many hats" kind="info">
          Test runner, type checker, linter, formatter check, benchmark, migration dry-run, license
          audit — anything with a shell entry point and a meaningful exit code is already an evaluator.
          Write bespoke evaluator plug-ins only when a CLI + exit code genuinely can't express the
          measurement.
        </Callout>
      </Section>

      <Section title="The experiment evaluator: metrics with a paper trail">
        <Code file="options for uses: experiment">{`command: "node bench.js"     # prints JSON to stdout (preferred), OR
metricsFile: "metrics.json"  # a file in the workspace (agent-writable!)
metric: "variantB.p95Ms"     # dot-path into the JSON
direction: "decrease"        # which way is better
baseline: 240                # compare against a known control value
minDelta: 20                 # require ≥ this much improvement
minValue: 0                  # absolute floor / ceiling
maxValue: 200
`}</Code>
        <Callout title="command vs metricsFile is a trust decision" kind="warn">
          With <code>command</code>, the evaluator produces the number at evaluation time — the agent
          can only improve it by improving the code. With <code>metricsFile</code>, the agent (or its
          code) writes the file the evaluator reads; nothing prevents writing the target number
          directly. Prefer <code>command</code>; treat <code>metricsFile</code> as convenient
          scaffolding for trusted harnesses only.
        </Callout>
      </Section>

      <Section title="Now judge for yourself">
        <JudgeGame />
      </Section>

      <Section title="The authoring pipeline (in-repo skills)">
        <p>
          The repo encodes this discipline as skills: <strong>frame-app</strong> decomposes a whole app
          into a dependency-ordered DAG of RED-able slices; <strong>frame-checks</strong> turns one
          request into falsifiable acceptance checks (each RED now, for the right reason, hard to
          fake); <strong>author-loop</strong> interviews you, inspects the repo for real commands, and
          proves the resulting spec lint-clean and RED before it's allowed to exist. "Verified RED
          first" is the project's cultural core — a check that was never RED proves nothing when it
          turns GREEN.
        </p>
      </Section>

      <Quiz
        moduleId="evaluator-design"
        questions={[
          {
            q: "A command check has scoreRegex + scoreGte: 85, the command exits 0, but the regex matches nothing. Result?",
            options: [
              "Pass — exit code wins",
              "Fail — a score was required but not produced",
              "Pass with score: 0",
              "The evaluator throws",
            ],
            answer: 1,
            explain:
              "When scoreGte/scoreLte are set, a missing score fails the check ('expected a score but the scoreRegex matched nothing'). Fail-closed again: required evidence that's absent is failure, not success.",
          },
          {
            q: "Why prefer `command` over `metricsFile` in the experiment evaluator when trust matters?",
            options: [
              "command is faster",
              "The evaluator produces the metric at evaluation time instead of reading an agent-writable file",
              "metricsFile doesn't support dot-paths",
              "command supports baselines; metricsFile doesn't",
            ],
            answer: 1,
            explain:
              "An agent-writable metrics file lets the agent write the target number directly. When the evaluator runs the benchmark itself, the only way to move the number is to change the code being measured.",
          },
          {
            q: "Your only evaluator is `npx tsc --noEmit` and the requirement is a new API behavior. Biggest risk?",
            options: [
              "The check is too slow",
              "The agent satisfies the check without implementing the behavior — compiling isn't the requirement",
              "tsc exit codes are unreliable",
              "The check can't run sequentially",
            ],
            answer: 1,
            explain:
              "Guards keep checks honest but can't make them strong. A type-check green is compatible with 'the feature doesn't exist'. Every requirement needs at least one check that is RED until that requirement is actually met.",
          },
          {
            q: "What makes a check's failure output an engineering concern in this system?",
            options: [
              "It's stored in the report forever",
              "The output tail literally becomes the agent's next prompt — vague output means blind iteration",
              "Long output slows the engine",
              "Output is parsed for security issues",
            ],
            answer: 1,
            explain:
              "buildFeedback embeds the failing check's output (tail, default 3000 chars) into the iteration prompt. An assertion message like 'expected 429, got 200 on request 101' steers the agent directly; 'Error: failed' burns iterations.",
          },
          {
            q: "You want a coverage floor of 85% via the command evaluator. Which option set does it?",
            options: [
              "expectExitCode: 85",
              "scoreRegex capturing the coverage number + scoreGte: 85",
              "minValue: 85",
              "guard: [\"coverage/\"]",
            ],
            answer: 1,
            explain:
              "scoreRegex (one capture group, parsed as a number) plus scoreGte turns any number-printing CLI into a threshold gate. minValue belongs to the experiment evaluator; expectExitCode is about exit codes.",
          },
          {
            q: "Best placement for a 25-minute full e2e suite in a loop-based workflow?",
            options: [
              "The only evaluator in the loop",
              "A final gate (or downstream batch item) after fast, focused per-iteration checks",
              "Run it in the baseline only",
              "Split across 5 parallel evaluators",
            ],
            answer: 1,
            explain:
              "Loops live on iteration speed. Fast checks that pin the requirement give per-turn feedback; the expensive suite runs once as a gate — e.g. a .batch.yaml item that `needs` this loop.",
          },
        ]}
      />
    </div>
  );
}
