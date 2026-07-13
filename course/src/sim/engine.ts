/**
 * A step-through simulation of LoopEngine.run() (src/core/engine.ts).
 * Each scenario is a scripted run; the log lines and outcomes mirror what the
 * real engine logs and returns, and verdict/feedback text is produced by the
 * ported evaluateCriteria/buildFeedback so it is authentic.
 */
import { evaluateCriteria } from "./criteria";
import { buildFeedback } from "./feedback";
import type { EvalResult } from "./types";

export interface SimLine {
  cls: "info" | "dim" | "warn" | "err" | "ok" | "prompt" | "phase";
  text: string;
}

export interface SimStep {
  /** Short label shown on the step button / timeline. */
  label: string;
  lines: SimLine[];
  /** Teaching note displayed next to the console. */
  explain: string;
}

export interface Scenario {
  id: string;
  title: string;
  outcome: string;
  outcomeKind: "good" | "bad" | "warn";
  description: string;
  steps: SimStep[];
}

const failTests = (detail: string): EvalResult => ({
  name: "tests",
  type: "command",
  ok: true,
  passed: false,
  feedback: `\`npm test\` → exit 1 ✗\n\noutput:\n${detail}`,
});

const passTests: EvalResult = {
  name: "tests",
  type: "command",
  ok: true,
  passed: true,
  feedback: "`npm test` → exit 0 ✓",
};

const passCheck: EvalResult = {
  name: "static-check",
  type: "command",
  ok: true,
  passed: true,
  feedback: "`npx tsc --noEmit` → exit 0 ✓",
};

function preflightStep(): SimStep {
  return {
    label: "Preflight",
    lines: [
      { cls: "phase", text: "── preflight ──" },
      { cls: "info", text: "workspace: /work/my-app" },
      { cls: "dim", text: "workspacePreflight: workspace exists, referenced binaries/scripts found" },
      { cls: "dim", text: "driver claude-agent-sdk: SDK installed, API key present ✓" },
      { cls: "dim", text: "evaluator tests: command `npm test` ✓" },
      { cls: "dim", text: "evaluator static-check: command `npx tsc --noEmit` ✓" },
    ],
    explain:
      "Before spending a single agent token, the engine runs preflight: workspace sanity from the lint layer (rules marked preflight: true), then the driver's own check (is the SDK installed? is the API key set?), then every evaluator's check. Any failure ends the run immediately with outcome `preflight-failed`.",
  };
}

function agentStep(iter: number, summary: string, files: string[]): SimStep {
  return {
    label: `Iter ${iter + 1}: agent`,
    lines: [
      { cls: "phase", text: `── iteration ${iter + 1} · drive agent ──` },
      { cls: "prompt", text: iter === 0 ? "prompt: buildInitialPrompt(spec)  (task + requirements + stack + checks)" : "prompt: buildIterationPrompt(spec, feedback)  (previous evaluator feedback)" },
      { cls: "info", text: `agent: ${summary}` },
      { cls: "dim", text: `stopReason: completed · changedFiles (driver-reported): ${files.length ? files.join(", ") : "(none)"}` },
    ],
    explain:
      iter === 0
        ? "Iteration 0 gets the initial prompt built by the task type: requirements, stack, and a description of every check that will run. Later iterations get something different — the feedback block. The system prompt (role + operating rules) is the same every iteration."
        : "From iteration 1 on, the agent is NOT re-sent the requirements by default — it gets the feedback block: overall verdict, a bounded diff of its own last changes, failing checks in full, passing checks as a summary.",
  };
}

function snapshotStep(iter: number, files: string[], changed: boolean): SimStep {
  return {
    label: `Iter ${iter + 1}: diff`,
    lines: [
      { cls: "phase", text: `── iteration ${iter + 1} · snapshot & diff ──` },
      { cls: "dim", text: "snapshotTree(workdir) → throwaway git index (never touches your real index)" },
      changed
        ? { cls: "info", text: `diffTrees: ${files.length} file(s) changed — ${files.join(", ")}` }
        : { cls: "warn", text: "diffTrees: no changes detected (ignoring artifacts + spec + guarded files)" },
    ],
    explain:
      "The engine measures what actually changed with its own git snapshot diff — it does not trust the driver's self-reported changedFiles when git is available. The spec file, guarded evaluator files, and build artifacts are excluded, so editing your own success criteria never counts as work.",
  };
}

function evalStep(iter: number, results: EvalResult[]): SimStep {
  return {
    label: `Iter ${iter + 1}: evaluate`,
    lines: [
      { cls: "phase", text: `── iteration ${iter + 1} · run evaluators ──` },
      ...results.map(
        (r): SimLine => ({
          cls: r.passed ? "ok" : "err",
          text: `${r.name} [${r.type}]: ${r.passed ? "PASS" : "FAIL"}`,
        }),
      ),
    ],
    explain:
      "Evaluators run sequentially by default (evaluation.concurrency: 1) so checks sharing external state — e.g. several commands hitting one database — can never race each other into false failures. A throwing evaluator becomes a failed result with ok: false; it never crashes the run.",
  };
}

function verdictStep(iter: number, results: EvalResult[], diffFiles: string[]): SimStep {
  const verdict = evaluateCriteria({ type: "all-pass" }, results);
  const fb = buildFeedback(results, verdict, diffFiles.length ? { diff: { files: diffFiles } } : {});
  return {
    label: `Iter ${iter + 1}: verdict`,
    lines: [
      { cls: "phase", text: `── iteration ${iter + 1} · criteria & feedback ──` },
      { cls: verdict.satisfied ? "ok" : "warn", text: `evaluateCriteria(all-pass): ${verdict.satisfied ? "PASS" : "not yet"} — ${verdict.reason}` },
      ...(verdict.satisfied
        ? []
        : [
            { cls: "dim", text: "buildFeedback(...) → next iteration's prompt:" } as SimLine,
            ...fb.text.split("\n").slice(0, 14).map((t): SimLine => ({ cls: "prompt", text: "  │ " + t })),
          ]),
    ],
    explain:
      "The declarative success criteria (all-pass here) are checked against the results. If not satisfied, buildFeedback renders the block the agent will see next turn — failing checks first and in full (that's what must be fixed), passing checks summarized (don't regress them), plus the diff of what the agent just changed.",
  };
}

function outcomeStep(kind: "good" | "bad" | "warn", outcome: string, lines: SimLine[], explain: string): SimStep {
  return {
    label: `Outcome: ${outcome}`,
    lines: [{ cls: "phase", text: "── terminal report ──" }, ...lines],
    explain,
  };
}

/* ---------------------------------------------------------------- */

const happyPath: Scenario = {
  id: "happy",
  title: "Happy path (converges in 2 iterations)",
  outcome: "success",
  outcomeKind: "good",
  description: "The normal life of a loop: RED on iteration 1, feedback, GREEN on iteration 2.",
  steps: [
    preflightStep(),
    agentStep(0, "implemented src/slug.ts, added tests", ["src/slug.ts", "test/slug.test.ts"]),
    snapshotStep(0, ["src/slug.ts", "test/slug.test.ts"], true),
    evalStep(0, [failTests("FAIL test/slug.test.ts — expected 'ünïcode' to normalize to 'unicode'"), passCheck]),
    verdictStep(0, [failTests("FAIL test/slug.test.ts — expected 'ünïcode' to normalize to 'unicode'"), passCheck], ["src/slug.ts", "test/slug.test.ts"]),
    agentStep(1, "fixed unicode normalization in src/slug.ts", ["src/slug.ts"]),
    snapshotStep(1, ["src/slug.ts"], true),
    evalStep(1, [passTests, passCheck]),
    outcomeStep(
      "good",
      "success",
      [
        { cls: "ok", text: "outcome: success — all checks passed" },
        { cls: "dim", text: "iterations: 2 · changedFiles: src/slug.ts, test/slug.test.ts" },
        { cls: "dim", text: "warnings: (none)" },
      ],
      "A satisfied verdict returns immediately — before the budget ceiling is even checked. Reaching the goal is never penalized; budgets only stop FURTHER spending. The report carries the whole-run diff and any honest warnings.",
    ),
  ],
};

const vacuousBaseline: Scenario = {
  id: "vacuous",
  title: "Vacuous checks (strict baseline)",
  outcome: "baseline-vacuous",
  outcomeKind: "bad",
  description: "limits.baseline: \"strict\" — the checks pass before the agent does anything, so the run refuses to start.",
  steps: [
    preflightStep(),
    {
      label: "Baseline eval",
      lines: [
        { cls: "phase", text: "── baseline evaluation (no agent) ──" },
        { cls: "info", text: "running baseline evaluation (no agent) — disable with limits.baseline: false" },
        { cls: "ok", text: "tests [command]: PASS" },
        { cls: "ok", text: "static-check [command]: PASS" },
        { cls: "warn", text: "success criteria already pass BEFORE any agent work — your checks likely do not verify the new requirement" },
      ],
      explain:
        "Baseline runs the evaluators once before any agent work. Green-before-work is the signature of checks that don't test the new requirement (they'd pass no matter what the agent does). Default is baseline: false (off) because checks with side effects would run twice; \"true\" warns, \"strict\" fails hard.",
    },
    outcomeStep(
      "bad",
      "baseline-vacuous",
      [
        { cls: "err", text: "outcome: baseline-vacuous — strict baseline: success criteria already pass BEFORE any agent work" },
        { cls: "dim", text: "iterations: 0 · $0.00 spent" },
      ],
      "Strict baseline turns 'your checks prove nothing' into a hard failure before a single agent token is spent. This is the cheapest trust guard: a check that can't go RED can't verify anything.",
    ),
  ],
};

const noopGreen: Scenario = {
  id: "noop",
  title: "Green but no work (vacuous-success warning)",
  outcome: "success (with warning)",
  outcomeKind: "warn",
  description: "The criteria pass on iteration 1 — but the workspace diff is empty. Success, with an honest caveat.",
  steps: [
    preflightStep(),
    agentStep(0, "\"everything already looks correct to me\"", []),
    snapshotStep(0, [], false),
    evalStep(0, [passTests, passCheck]),
    outcomeStep(
      "warn",
      "success + warning",
      [
        { cls: "ok", text: "outcome: success — all checks passed" },
        { cls: "warn", text: "warning: criteria satisfied but the agent changed no files — this run may not have done any work (checks may be vacuous)" },
      ],
      "The engine never upgrades this to a failure — maybe the code really was already correct — but it refuses to let a no-op green look identical to a real one. This warning plus a passing baseline is near-proof your checks are vacuous.",
    ),
  ],
};

const specTamper: Scenario = {
  id: "tamper",
  title: "Spec tampering (specGuard: error)",
  outcome: "spec-tampered",
  outcomeKind: "bad",
  description: "The agent edits the .loop.yaml mid-run to weaken its own success criteria.",
  steps: [
    preflightStep(),
    {
      label: "Guard setup",
      lines: [
        { cls: "phase", text: "── guard setup ──" },
        { cls: "dim", text: "spec file lives inside the workspace → sha256 hash recorded" },
        { cls: "dim", text: "spec excluded from work diff (editing it never counts as work)" },
      ],
      explain:
        "When the spec file lives inside the workspace the agent can reach it. The engine hashes it at start and — independently of the guard policy — always excludes it from the work diff. Note: the run always evaluates the ORIGINAL in-memory spec; tampering can only fool the NEXT run.",
    },
    agentStep(0, "edited task.loop.yaml: removed the failing evaluator; touched src/app.ts", ["src/app.ts"]),
    evalStep(0, [passTests, passCheck]),
    {
      label: "Tamper check",
      lines: [
        { cls: "phase", text: "── success path · re-hash watched files ──" },
        { cls: "err", text: "spec hash mismatch: task.loop.yaml was modified during the run" },
      ],
      explain:
        "On every terminal path that could have seen agent activity, the engine re-hashes the watched spec. With specGuard: \"error\", a mid-run edit converts an apparent success into outcome spec-tampered; with \"warn\" (the default) it's a loud caveat on a green run.",
    },
    outcomeStep(
      "bad",
      "spec-tampered",
      [
        { cls: "err", text: "outcome: spec-tampered — the agent modified the loop spec file during the run (specGuard: error)" },
        { cls: "dim", text: "success: false — even though the criteria were satisfied" },
      ],
      "The criteria passed, but a green from an agent that rewrote its own contract is worthless. Spec-tamper takes precedence over evaluator-tamper when both fire.",
    ),
  ],
};

const budget: Scenario = {
  id: "budget",
  title: "Budget ceiling (maxCostUsd)",
  outcome: "budget-exceeded",
  outcomeKind: "bad",
  description: "limits.maxCostUsd: 1.00 — a non-converging iteration pushes cumulative cost over the cap.",
  steps: [
    preflightStep(),
    agentStep(0, "large refactor attempt ($0.70)", ["src/parser.ts"]),
    evalStep(0, [failTests("14 tests failing"), passCheck]),
    {
      label: "Budget check",
      lines: [
        { cls: "phase", text: "── iteration 1 · budget ceiling ──" },
        { cls: "dim", text: "cumulative usage: $0.70 ≤ $1.00 → continue" },
      ],
      explain:
        "The budget is checked only AFTER an iteration fails to converge. Cost first, then combined input+output tokens. A driver that reports no usage can never trip a budget — the cap is only as good as the driver's instrumentation.",
    },
    agentStep(1, "second attempt ($0.55 → total $1.25)", ["src/parser.ts"]),
    evalStep(1, [failTests("9 tests failing"), passCheck]),
    outcomeStep(
      "bad",
      "budget-exceeded",
      [
        { cls: "err", text: "outcome: budget-exceeded — cost budget exceeded: $1.2500 spent > $1.0000 limit (limits.maxCostUsd)" },
        { cls: "dim", text: "the loop stops rather than fund another turn" },
      ],
      "Note the asymmetry: if iteration 2 had PASSED, the run would report success even at $1.25 — a satisfied iteration returns before the budget check. Getting the result is never penalized; only further spend is capped.",
    ),
  ],
};

const maxIter: Scenario = {
  id: "maxiter",
  title: "Never converges (max-iterations)",
  outcome: "max-iterations",
  outcomeKind: "bad",
  description: "The iteration budget (default 5, here 2) runs out before the checks go green.",
  steps: [
    preflightStep(),
    agentStep(0, "attempt 1", ["src/api.ts"]),
    evalStep(0, [failTests("integration test: 500 instead of 201"), passCheck]),
    verdictStep(0, [failTests("integration test: 500 instead of 201"), passCheck], ["src/api.ts"]),
    agentStep(1, "attempt 2", ["src/api.ts"]),
    evalStep(1, [failTests("integration test: 500 instead of 201"), passCheck]),
    outcomeStep(
      "bad",
      "max-iterations",
      [
        { cls: "err", text: "outcome: max-iterations — exhausted 2 iteration(s) without satisfying: failing: tests" },
        { cls: "dim", text: "the report keeps every iteration's evaluations + diffs for debugging" },
      ],
      "The identical failure across iterations is a smell the report makes visible: the same reason string twice means the agent isn't making progress — usually a sign the feedback isn't actionable enough or the task is under-specified. (The engine itself does not currently detect stagnation.)",
    ),
  ],
};

export const SCENARIOS: Scenario[] = [happyPath, vacuousBaseline, noopGreen, specTamper, budget, maxIter];
