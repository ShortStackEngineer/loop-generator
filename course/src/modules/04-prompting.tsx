import { useState } from "react";
import { Callout, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";
import { buildSystemPrompt, buildInitialPrompt, buildIterationPrompt } from "../sim/prompts";
import { buildFeedback } from "../sim/feedback";
import { evaluateCriteria } from "../sim/criteria";
import type { EvalResult, MiniSpec } from "../sim/types";

type Tab = "system" | "initial" | "iteration";

export function Prompting() {
  const [taskType, setTaskType] = useState<MiniSpec["taskType"]>("function");
  const [name, setName] = useState("slugify-function");
  const [requirements, setRequirements] = useState(
    "Implement slugify(input: string): string in src/slug.ts.\nLowercase, trim, collapse whitespace to single hyphens, strip diacritics.",
  );
  const [language, setLanguage] = useState("typescript");
  const [withDiff, setWithDiff] = useState(true);
  const [tab, setTab] = useState<Tab>("initial");

  const spec: MiniSpec = {
    name,
    requirements,
    language,
    taskType,
    evaluators: [
      { uses: "command", as: "tests", command: "npm test" },
      { uses: "command", as: "static-check", command: "npx tsc --noEmit" },
    ],
  };

  const results: EvalResult[] = [
    {
      name: "tests",
      type: "command",
      ok: true,
      passed: false,
      feedback:
        "`npm test` → exit 1 ✗\n\noutput:\nFAIL test/slug.test.ts\n  ✕ strips diacritics (5 ms)\n  expected 'crème brûlée' → 'creme-brulee', received 'crème-brûlée'\nTests: 1 failed, 7 passed",
    },
    { name: "static-check", type: "command", ok: true, passed: true, feedback: "`npx tsc --noEmit` → exit 0 ✓" },
  ];
  const verdict = evaluateCriteria({ type: "all-pass" }, results);
  const feedback = buildFeedback(results, verdict, {
    diff: withDiff
      ? {
          files: ["src/slug.ts", "test/slug.test.ts"],
          patch:
            "--- a/src/slug.ts\n+++ b/src/slug.ts\n@@ -1,3 +1,8 @@\n+export function slugify(input: string): string {\n+  return input.trim().toLowerCase().replace(/\\s+/g, \"-\");\n+}",
        }
      : undefined,
  });

  const text =
    tab === "system"
      ? buildSystemPrompt(spec)
      : tab === "initial"
        ? buildInitialPrompt(spec)
        : buildIterationPrompt(spec, feedback);

  return (
    <div>
      <Section title="Three texts, three jobs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Text</th>
              <th>Sent</th>
              <th>Contains</th>
              <th>Built by</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>System prompt</strong></td>
              <td>Every iteration (constant)</td>
              <td>Role + loop framing + operating rules + task-type guidance</td>
              <td><code>taskType.buildSystemPrompt</code> (or <code>prompts.system</code> override)</td>
            </tr>
            <tr>
              <td><strong>Initial prompt</strong></td>
              <td>Iteration 0 only</td>
              <td>Task name, description, requirements, stack, criteria goal, list of checks</td>
              <td><code>taskType.buildInitialPrompt</code> (or <code>prompts.initial</code> override)</td>
            </tr>
            <tr>
              <td><strong>Iteration prompt</strong></td>
              <td>Iterations 1+</td>
              <td>Feedback block: verdict, diff of the agent's own last changes, failing checks in full, passing checks summarized</td>
              <td><code>taskType.buildIterationPrompt(spec, feedback)</code></td>
            </tr>
          </tbody>
        </table>
        <Callout title="The key asymmetry" kind="warn">
          By default the <strong>requirements are only ever sent once</strong>, on iteration 0. From
          iteration 1 on, the engine's contract with the agent is: <em>the failing checks ARE the
          requirements</em>. If a requirement isn't pinned by a check, nothing reminds the agent of it
          after the first turn. This is why evaluator design (Module 6) matters so much — and why the
          engine hands the agent a diff of its own last changes, so a driver that starts each iteration
          cold doesn't re-derive (or redo) its own work.
        </Callout>
      </Section>

      <Section title="Build the prompts live">
        <p>
          These are the <em>real</em> assembly functions from <code>src/tasks/base.ts</code> — the
          course imports them straight from the engine source. Edit the spec; read what the model
          reads.
        </p>
        <div className="card">
          <div className="two-col">
            <div>
              <div className="field-row">
                <label>task.type</label>
                <select value={taskType} onChange={(e) => setTaskType(e.target.value as MiniSpec["taskType"])}>
                  <option value="function">function</option>
                  <option value="api">api</option>
                  <option value="webapp">webapp</option>
                  <option value="experiment">experiment</option>
                  <option value="generic">generic</option>
                </select>
              </div>
              <div className="field-row">
                <label>name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field-row">
                <label>stack.language</label>
                <input value={language} onChange={(e) => setLanguage(e.target.value)} />
              </div>
              <div className="field-row">
                <label>requirements</label>
                <textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} />
              </div>
              <div className="pill-row">
                <button className={`pill ${withDiff ? "on" : ""}`} onClick={() => setWithDiff(!withDiff)}>
                  git change detection {withDiff ? "on (diff included)" : "off (no diff)"}
                </button>
              </div>
            </div>
            <div>
              <div className="pill-row">
                <button className={`pill ${tab === "system" ? "on" : ""}`} onClick={() => setTab("system")}>
                  System (every turn)
                </button>
                <button className={`pill ${tab === "initial" ? "on" : ""}`} onClick={() => setTab("initial")}>
                  Initial (iteration 0)
                </button>
                <button className={`pill ${tab === "iteration" ? "on" : ""}`} onClick={() => setTab("iteration")}>
                  Iteration 1+ (feedback)
                </button>
              </div>
              <pre className="codeblock" style={{ maxHeight: 460, overflowY: "auto" }}>{text}</pre>
            </div>
          </div>
        </div>
        <Callout title="Read the iteration prompt carefully" kind="info">
          Switch to the <em>Iteration 1+</em> tab. Notice the ordering — it's deliberate: overall
          verdict first, then the diff of what the agent already did, then <strong>failing checks in
          full</strong> (that's the work), then passing checks as a one-line summary (don't regress
          them). Each failing check's output is truncated to 4,000 chars, keeping the first 25% and the
          last 75% — test runners put the useful summary at the end.
        </Callout>
      </Section>

      <Section title="Where feedback comes from">
        <p>
          The feedback block isn't written by a model — it's a deterministic render
          (<code>buildFeedback</code> in <code>src/core/feedback.ts</code>) of evaluator results plus the
          criteria verdict. The agent's fix loop is therefore only as good as the evaluator's{" "}
          <code>feedback</code> string. A <code>command</code> evaluator feeds back the tail of the
          command's output (default 3,000 chars) — which is why "make your test runner print actionable
          failures" is an evaluator-design concern, not a nicety.
        </p>
      </Section>

      <Quiz
        moduleId="prompting"
        questions={[
          {
            q: "On iteration 3 of a default-configured run, which of these does the agent NOT receive?",
            options: [
              "The system prompt",
              "The requirements text from the spec",
              "The failing checks' output",
              "A list of passing checks",
            ],
            answer: 1,
            explain:
              "Requirements ride only in the initial prompt (iteration 0). Later iterations get the feedback block. If you need requirements repeated every turn, override prompts.iteration — your text is prepended to the feedback.",
          },
          {
            q: "Why does the engine include a diff of the agent's last changes in the feedback?",
            options: [
              "To let the user review the changes",
              "So the next iteration doesn't re-derive or redo work it already did",
              "To enable git bisect later",
              "To count tokens accurately",
            ],
            answer: 1,
            explain:
              "Drivers may start each iteration cold (new session). The bounded, ignore-respecting diff reminds the agent of its own prior work, preventing wasted turns re-exploring. It's git-only for the unified patch; content-hash runs still list changed files.",
          },
          {
            q: "How are failing vs passing checks presented in feedback?",
            options: [
              "Alphabetically, all in full",
              "Failing first and in full; passing as a summary line each",
              "Passing first to encourage the agent",
              "Only failing checks are included",
            ],
            answer: 1,
            explain:
              "Failing checks are what the agent must fix, so they come first with full (truncated-at-4000-chars) output. Passing checks appear as one-liners so the agent knows not to regress them — omitting them entirely invites regressions.",
          },
          {
            q: "Which operating rule appears in every generated system prompt?",
            options: [
              "\"Always write tests first\"",
              "\"Do not weaken or delete checks to make them pass\"",
              "\"Prefer functional programming\"",
              "\"Commit after every change\"",
            ],
            answer: 1,
            explain:
              "The shared rules are: confine edits to the workspace; make concrete edits, don't ask questions; prefer minimal correct changes and never weaken/delete checks; fix failing checks without regressing passing ones. The anti-check-tampering rule is the prompt-level twin of the integrity guards.",
          },
          {
            q: "The 4,000-char truncation of a failing check's feedback keeps…",
            options: [
              "the first 4,000 chars",
              "the last 4,000 chars",
              "the first 25% and the last 75% of the budget, with a marker in between",
              "a random sample",
            ],
            answer: 2,
            explain:
              "truncate() keeps head = 25% and tail = 75% of the budget around an '…[N chars omitted]…' marker. Rationale: a test runner's tail has the failure summary; the head has the command/context.",
          },
        ]}
      />
    </div>
  );
}
