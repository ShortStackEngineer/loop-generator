import { useState } from "react";
import { Callout, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";
import { evaluateCriteria, describeCriteria } from "../sim/criteria";
import type { EvalResult, SuccessCriteria } from "../sim/types";

interface SpecField {
  id: string;
  yaml: string;
  title: string;
  explain: string;
}

const FIELDS: SpecField[] = [
  {
    id: "head",
    yaml: `version: 1
name: rate-limit-middleware
description: Add a fixed-window rate limiter to the API.`,
    title: "Identity",
    explain:
      "version is literally 1 (the only accepted value, defaulted). name is required and non-empty — it labels reports and prompts. description is optional prose that gets included in the initial prompt.",
  },
  {
    id: "task",
    yaml: `task:
  type: api`,
    title: "task.type — prompt scaffolding selector",
    explain:
      "Selects the TaskType plug-in that builds the prompts and recommends evaluators. Built-ins: function, api, webapp, experiment, generic. Defaults to \"function\". Advisory: an unregistered type falls back to genericTask instead of failing.",
  },
  {
    id: "stack",
    yaml: `stack:
  language: typescript
  framework: express
  packageManager: npm`,
    title: "stack — tells the agent (and the generator) the toolchain",
    explain:
      "Optional. language drives the generator's default evaluators (typescript → npm test + npx tsc --noEmit; python → pytest -q + ruff check .; …) and appears in the initial prompt's ## Stack section so the agent doesn't guess.",
  },
  {
    id: "workspace",
    yaml: `workspace:
  dir: .
  snapshot: none        # or "git"
  ignore: ["*.log"]`,
    title: "workspace — where the agent edits, and diff noise control",
    explain:
      "dir (default \".\") resolves relative to the spec file. ignore adds globs on top of DEFAULT_IGNORE_GLOBS (logs, tmp, build output, sqlite …) excluded from change detection, so runtime churn can't mask a no-op or inflate the diff. snapshot: git|none (default none) — git checkpoints the workspace into refs/loopgen/<run>/{pre-run,latest} (pre-run, then after each changed iteration; best-effort, git repos only, never moves HEAD/branches) so a failed run can be inspected and reset — the paste-safe commands come back on LoopReport.snapshot; none writes no checkpoints. Change detection is INDEPENDENT of this flag: it's on whenever the workspace is a usable git repo, regardless of snapshot.",
  },
  {
    id: "requirements",
    yaml: `requirements: |
  POST endpoints must be limited to 100 req/min per IP.
  Return 429 with a Retry-After header when exceeded.
  Existing tests must keep passing.`,
    title: "requirements — the actual task (required)",
    explain:
      "Required, min length 1. This is the text the agent receives under ## Requirements in the initial prompt — and, by default, ONLY in the initial prompt. Iterations 1+ get evaluator feedback instead, so requirements the checks don't enforce can silently fall out of view. Write checks that pin every requirement.",
  },
  {
    id: "driver",
    yaml: `driver:
  uses: claude-agent-sdk
  options:
    maxTurns: 30`,
    title: "driver — which coding agent does the work",
    explain:
      "uses is resolved against the driver registry (mock, claude-agent-sdk, grok, github-copilot, opencode). A typo fails fast before any work. options is an open object passed to the driver verbatim; the CLI can override with `loopgen run -d <name>`.",
  },
  {
    id: "evaluators",
    yaml: `evaluators:
  - uses: command
    as: tests
    options: { command: "npm test" }
  - uses: command
    as: static-check
    options: { command: "npx tsc --noEmit" }
    guard: ["test/"]`,
    title: "evaluators — the measurement tools",
    explain:
      "Each entry names an evaluator type (uses) with an optional instance alias (as) so two command checks stay distinct — criteria refer to that name. guard lists extra files/directories the evaluator-integrity guard should hash-watch, beyond the test-like files auto-detected from the command string.",
  },
  {
    id: "success",
    yaml: `success:
  type: all-pass`,
    title: "success — declarative criteria over evaluator results",
    explain:
      "Default: all-pass (every evaluator must pass; fails if zero evaluators are configured). Composable: pass (named subset), score (gte/lte/eq on an evaluator's numeric score), and all / any / not combinators — e.g. \"tests pass AND p95 < 200ms\". Try the playground below.",
  },
  {
    id: "limits",
    yaml: `limits:
  maxIterations: 5
  iterationTimeoutMs: 600000
  maxCostUsd: 2.50
  maxTokens: 400000
  baseline: strict      # false | true | "strict"
  specGuard: warn       # off | warn | error
  evaluatorGuard: warn  # off | warn | error`,
    title: "limits — budgets and trust guards",
    explain:
      "maxIterations defaults to 5. iterationTimeoutMs aborts a single iteration. maxCostUsd / maxTokens (input+output) cap cumulative driver-reported usage — checked only after a non-converging iteration, and unenforceable if the driver reports no usage. baseline defaults to false (off!) because side-effecting checks would run twice. Both guards default to \"warn\".",
  },
  {
    id: "evaluation",
    yaml: `evaluation:
  concurrency: 1`,
    title: "evaluation.concurrency — sequential by default",
    explain:
      "Default 1: evaluators run one at a time so checks sharing external state (one database) can't race into false failures. Raise only for genuinely independent checks.",
  },
  {
    id: "observability",
    yaml: `observability:
  observers:
    - uses: jsonl
      options: { file: trace.jsonl }`,
    title: "observability — attach telemetry",
    explain:
      "Observers (jsonl, otlp) see run/iteration/agent events and the terminal report. They never affect outcomes. `loopgen run --trace <file>` is the CLI shortcut for the JSONL one.",
  },
  {
    id: "prompts",
    yaml: `prompts:
  system: |            # optional overrides
    You are …
  initial: …
  iteration: …`,
    title: "prompts — override the task type's generated prompts",
    explain:
      "Optional full overrides. system and initial replace the generated ones entirely. iteration is different: your text is PREPENDED and the engine still appends the feedback block — feedback delivery can't be overridden away.",
  },
];

function CriteriaPlayground() {
  const [testsPass, setTestsPass] = useState(false);
  const [checkPass, setCheckPass] = useState(true);
  const [perf, setPerf] = useState(180);
  const [mode, setMode] = useState<"all-pass" | "pass" | "composite">("all-pass");

  const results: EvalResult[] = [
    { name: "tests", type: "command", ok: true, passed: testsPass, feedback: "" },
    { name: "static-check", type: "command", ok: true, passed: checkPass, feedback: "" },
    { name: "p95-latency", type: "command", ok: true, passed: true, score: perf, feedback: "" },
  ];

  const criteria: SuccessCriteria =
    mode === "all-pass"
      ? { type: "all-pass" }
      : mode === "pass"
        ? { type: "pass", evaluators: ["tests"] }
        : {
            type: "all",
            of: [
              { type: "pass", evaluators: ["tests", "static-check"] },
              { type: "score", evaluator: "p95-latency", lte: 200 },
            ],
          };

  const verdict = evaluateCriteria(criteria, results);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Criteria playground</h3>
      <p style={{ fontSize: 14, color: "var(--muted)" }}>
        Flip the evaluator results, switch the criteria shape, and watch <code>evaluateCriteria</code>{" "}
        (the exact ported engine function) produce its verdict and reason string.
      </p>
      <div className="pill-row">
        <button className={`pill ${mode === "all-pass" ? "on" : ""}`} onClick={() => setMode("all-pass")}>
          all-pass
        </button>
        <button className={`pill ${mode === "pass" ? "on" : ""}`} onClick={() => setMode("pass")}>
          pass: [tests]
        </button>
        <button className={`pill ${mode === "composite" ? "on" : ""}`} onClick={() => setMode("composite")}>
          all(pass[tests,static-check], score p95 ≤ 200)
        </button>
      </div>
      <div className="pill-row">
        <button className={`pill ${testsPass ? "on" : ""}`} onClick={() => setTestsPass(!testsPass)}>
          tests: {testsPass ? "PASS" : "FAIL"}
        </button>
        <button className={`pill ${checkPass ? "on" : ""}`} onClick={() => setCheckPass(!checkPass)}>
          static-check: {checkPass ? "PASS" : "FAIL"}
        </button>
        <button className="pill" onClick={() => setPerf((p) => (p === 180 ? 240 : 180))}>
          p95-latency score: {perf} ms (click to toggle)
        </button>
      </div>
      <div className="sim-console" style={{ maxHeight: 140 }}>
        <div className="sim-line dim">criteria: {describeCriteria(criteria)}</div>
        <div className={`sim-line ${verdict.satisfied ? "ok" : "err"}`}>
          {verdict.satisfied ? "SATISFIED" : "NOT SATISFIED"} — {verdict.reason}
        </div>
      </div>
    </div>
  );
}

export function SpecAnatomy() {
  const [sel, setSel] = useState<string>("requirements");
  const field = FIELDS.find((f) => f.id === sel)!;

  return (
    <div>
      <Section title="Explore a spec, field by field">
        <p>
          Click any block of the spec to see what it controls, what the schema defaults it to, and the
          traps hiding in it.
        </p>
        <div className="two-col">
          <div>
            {FIELDS.map((f) => (
              <div
                key={f.id}
                onClick={() => setSel(f.id)}
                style={{
                  cursor: "pointer",
                  border: `2px solid ${sel === f.id ? "var(--green)" : "transparent"}`,
                  borderRadius: 10,
                  margin: "6px 0",
                  background: "var(--code-bg)",
                }}
              >
                <pre
                  className="codeblock"
                  style={{ border: "none", margin: 0, background: "transparent", fontSize: 12.3 }}
                >
                  {f.yaml}
                </pre>
              </div>
            ))}
          </div>
          <div style={{ position: "sticky", top: 20 }}>
            <div className="callout" style={{ margin: 0 }}>
              <div className="callout-title">{field.title}</div>
              <p style={{ fontSize: 14.5, margin: "6px 0 0" }}>{field.explain}</p>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Success criteria are a little language">
        <CriteriaPlayground />
        <Callout title="Gotcha: all-pass with zero evaluators" kind="warn">
          <code>all-pass</code> with an empty evaluator list is <em>never</em> satisfied ("no evaluators
          were configured") — and since <code>evaluators</code> defaults to <code>[]</code> and{" "}
          <code>success</code> defaults to <code>all-pass</code>, a spec that simply forgets its
          evaluators can never converge. The <code>SPEC-NO-EVALUATORS</code> lint rule catches this as
          an error, and because it's a preflight rule the engine also fails fast at run time
          (<code>preflight-failed</code>, zero agent spend) — unless you run with{" "}
          <code>--skip-preflight</code>, in which case the loop burns all 5 iterations and ends as{" "}
          <code>max-iterations</code>.
        </Callout>
      </Section>

      <Quiz
        moduleId="spec-anatomy"
        questions={[
          {
            q: "Which limits defaults are correct?",
            options: [
              "maxIterations: 10, baseline: true, guards: error",
              "maxIterations: 5, baseline: false, specGuard/evaluatorGuard: warn",
              "maxIterations: 5, baseline: strict, guards: warn",
              "maxIterations: 3, baseline: false, guards: off",
            ],
            answer: 1,
            explain:
              "Defaults: maxIterations 5, baseline false (off — because side-effecting checks would run twice), and both integrity guards \"warn\". Hardening a spec usually means baseline: strict and guards: error.",
          },
          {
            q: "Why does evaluation.concurrency default to 1?",
            options: [
              "To keep evaluator output ordered in the logs",
              "So evaluators sharing external state (e.g. one database) can't race into false failures",
              "Because evaluators are CPU-bound",
              "To make budget accounting deterministic",
            ],
            answer: 1,
            explain:
              "Sequential-by-default is a correctness choice: two checks migrating/seeding the same DB in parallel can deadlock or corrupt each other, producing false REDs. Opt into parallelism only for independent checks.",
          },
          {
            q: "You set prompts.iteration to a custom string. What does the agent see on iteration 2?",
            options: [
              "Only your custom string",
              "Your custom string, then the engine's feedback block appended",
              "The feedback block only — prompts.iteration is ignored after iteration 1",
              "Your custom string with {feedback} placeholders substituted",
            ],
            answer: 1,
            explain:
              "buildIterationPrompt returns `${spec.prompts.iteration}\\n\\n${feedback.text}` — your text is a preamble, but the evaluator feedback is always appended. You can reshape the framing, not remove the measurements.",
          },
          {
            q: "What does evaluators[].as do?",
            options: [
              "Aliases the evaluator so criteria and reports can name this instance distinctly",
              "Casts the evaluator's output to a different type",
              "Marks the evaluator as advisory",
              "Renames the command being run",
            ],
            answer: 0,
            explain:
              "Two `command` evaluators would otherwise both be named \"command\". `as: tests` / `as: static-check` gives each instance a stable name that success criteria (pass/score) and feedback blocks refer to.",
          },
          {
            q: "success: { type: \"score\", evaluator: \"perf\", lte: 200 } — but the perf evaluator returned no score. Verdict?",
            options: [
              "Satisfied — a missing score means no constraint is violated",
              "Not satisfied — \"perf produced no score\"",
              "The run errors out",
              "The criteria falls back to all-pass",
            ],
            answer: 1,
            explain:
              "A score criterion on an evaluator that produced no numeric score is simply not satisfied — the reason string says so. Fail-closed: missing evidence is never treated as success.",
          },
        ]}
      />
    </div>
  );
}
