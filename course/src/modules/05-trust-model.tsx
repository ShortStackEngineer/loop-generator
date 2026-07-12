import { useState } from "react";
import { Callout, Section } from "../components/ui";
import { Quiz } from "../components/Quiz";

type GuardMode = "warn" | "error";

interface Attack {
  id: string;
  title: string;
  detail: string;
  verdict: (g: GuardMode) => { chip: string; kind: "good" | "bad" | "warn"; body: string };
}

const ATTACKS: Attack[] = [
  {
    id: "edit-spec",
    title: "Edit the .loop.yaml mid-run to weaken success criteria",
    detail: "The spec lives inside the workspace; the agent rewrites `success` and deletes an evaluator entry.",
    verdict: (g) =>
      g === "error"
        ? {
            chip: "spec-tampered",
            kind: "bad",
            body:
              "The spec was sha256-hashed at run start. On the success path the engine re-hashes it, sees the mismatch, and converts the green into outcome spec-tampered (success: false). Crucially, the running loop never re-reads the spec — it evaluates the ORIGINAL in-memory spec — so the edit could only have fooled the NEXT run.",
          }
        : {
            chip: "success + loud warning",
            kind: "warn",
            body:
              "With specGuard: warn (the default) the run still reports success, but carries: \"the agent modified the loop spec file … re-verify the on-disk spec before re-running\". Either way, the spec edit is excluded from the work diff — it never counts as work.",
          },
  },
  {
    id: "delete-spec",
    title: "Delete the .loop.yaml entirely",
    detail: "Instead of editing the spec, the agent removes the file.",
    verdict: () => ({
      chip: "NOT flagged by specGuard",
      kind: "bad",
      body:
        "A real hole in the current implementation: checkSpecTamper only flags when a NEW hash exists and differs (`if (now && now !== hash)`). A deleted spec hashes to null → no tamper flag. Contrast with the evaluator guard, where a missing watched file IS tampering (`now !== hash` with now null). The next `loopgen run` fails to load the spec, so the damage is bounded — but this run's green carries no caveat.",
    }),
  },
  {
    id: "edit-named-test",
    title: "Edit a test file that the check's command names",
    detail: "Evaluator command is `npx vitest run test/slug.test.ts`; the agent rewrites that test to always pass.",
    verdict: (g) =>
      g === "error"
        ? {
            chip: "evaluator-tampered",
            kind: "bad",
            body:
              "resolveGuardedFiles tokenizes each command and hash-watches test-like paths named in it (suffix .test./.spec./_test/_spec, or under test/, tests/, specs/, __tests__/) that exist at run start. The edit flips the hash → outcome evaluator-tampered. The file is also excluded from the work diff, so the edit never counted as work.",
          }
        : {
            chip: "success + loud warning",
            kind: "warn",
            body:
              "With evaluatorGuard: warn (default), the run stays green but warns: \"the agent modified file(s) an evaluator depends on … re-verify before trusting this result\". Set evaluatorGuard: error to make this a hard failure.",
          },
  },
  {
    id: "edit-suite-test",
    title: "Edit a test file behind a bare runner (`npm test`)",
    detail: "The command names no files — the agent weakens test/slug.test.ts, which `npm test` picks up implicitly.",
    verdict: () => ({
      chip: "NOT auto-detected",
      kind: "bad",
      body:
        "Auto-detection only watches files NAMED in the command. A bare `npm test` names nothing — the whole-suite case is intentionally not auto-watched (hashing every test in the repo would flag legitimate test-writing as tampering, and the function/api task guidance explicitly tells the agent to ADD tests). Your defense: `evaluators[].guard: [\"test/\"]` explicitly watches a directory recursively — use it when the suite is the contract and the agent shouldn't touch it.",
    }),
  },
  {
    id: "noop",
    title: "Change nothing and let pre-existing green checks pass",
    detail: "The checks were already passing; the agent does nothing and the criteria are satisfied.",
    verdict: () => ({
      chip: "success + vacuous warning (baseline catches it earlier)",
      kind: "warn",
      body:
        "Two layers respond. Change detection: a satisfied verdict with an empty diff warns \"criteria satisfied but the agent changed no files — checks may be vacuous\". Baseline (if enabled): the checks passing BEFORE any agent work is caught pre-loop; with baseline: \"strict\" the run hard-fails as baseline-vacuous without spending a token.",
    }),
  },
  {
    id: "fabricate",
    title: "Driver fabricates changedFiles to fake work",
    detail: "A buggy/malicious driver reports changedFiles: [\"src/app.ts\"] but wrote nothing (no git repo here).",
    verdict: () => ({
      chip: "claim ignored",
      kind: "good",
      body:
        "Off-git, the content-hash walk is authoritative under its file cap: it saw no changes, so the driver's claim is discarded and the vacuous-success warning still fires. Only when the walk hit its cap (possibly missed files) is the claim used — and then it's explicitly marked unverified. With git enabled, the driver's self-report isn't even consulted.",
    }),
  },
];

const DEFENSES: { name: string; what: string }[] = [
  {
    name: "Layer 0 — lint (pre-execution)",
    what: "Static spec checks in milliseconds, before any agent turn: unknown plug-in names, all-pass with zero evaluators, missing workspace, referenced binaries absent. Rules marked preflight: true also run inside engine preflight.",
  },
  {
    name: "Baseline evaluation",
    what: "Run the checks before any agent work. Already green ⇒ the checks likely don't test the requirement. Off by default (side-effecting checks would run twice); \"strict\" makes it a hard baseline-vacuous failure.",
  },
  {
    name: "Change detection",
    what: "Git tree diff via a throwaway index (content-hash fallback). Green + empty diff ⇒ vacuous-success warning. Artifacts, the spec file, and guarded evaluator files are excluded — editing your contract is never 'work'.",
  },
  {
    name: "Spec-integrity guard (specGuard)",
    what: "Hash-watch the in-workspace spec file; re-check on every terminal path that could have seen agent activity. warn (default) → caveat; error → outcome spec-tampered overrides an apparent green.",
  },
  {
    name: "Evaluator-integrity guard (evaluatorGuard)",
    what: "Same shape, applied to the real success criteria: test files named in commands + explicit guard paths. error → evaluator-tampered. Spec-tamper takes precedence when both fire.",
  },
  {
    name: "Honest-completion warnings",
    what: "Green with stopReason max_turns/error ⇒ 'success rests on the checks alone'. The engine never hides that the agent didn't finish cleanly.",
  },
];

export function TrustModel() {
  const [attackId, setAttackId] = useState(ATTACKS[0]!.id);
  const [guardMode, setGuardMode] = useState<GuardMode>("warn");
  const attack = ATTACKS.find((a) => a.id === attackId)!;
  const v = attack.verdict(guardMode);

  return (
    <div>
      <Section title="The problem: green can lie">
        <p>
          "All checks passed" is only meaningful if (1) the checks exercise the requirement and (2) the
          agent actually did work. An agent optimizing for green has cheaper paths than solving your
          problem: weaken the tests, rewrite the spec, or do nothing and hope the checks were vacuous.
          The engine's design assumption is that <em>the agent is an untrusted optimizer</em> — the same
          assumption you'd make about Goodhart's law anywhere else.
        </p>
      </Section>

      <Section title="Red team the engine">
        <p>
          Pick an attack, toggle the guard policy, and see exactly what the engine does — including the
          two attacks that currently slip through.
        </p>
        <div className="card">
          <div className="pill-row">
            {ATTACKS.map((a) => (
              <button
                key={a.id}
                className={`pill ${a.id === attackId ? "on" : ""}`}
                onClick={() => setAttackId(a.id)}
              >
                {a.title.length > 42 ? a.title.slice(0, 42) + "…" : a.title}
              </button>
            ))}
          </div>
          <h3 style={{ marginBottom: 4 }}>{attack.title}</h3>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>{attack.detail}</p>
          {(attack.id === "edit-spec" || attack.id === "edit-named-test") && (
            <div className="pill-row">
              <button className={`pill ${guardMode === "warn" ? "on" : ""}`} onClick={() => setGuardMode("warn")}>
                guard: warn (default)
              </button>
              <button className={`pill ${guardMode === "error" ? "on" : ""}`} onClick={() => setGuardMode("error")}>
                guard: error
              </button>
            </div>
          )}
          <div>
            <span className={`outcome-chip ${v.kind}`}>{v.chip}</span>
          </div>
          <p style={{ fontSize: 14.5 }}>{v.body}</p>
        </div>
      </Section>

      <Section title="The six defense layers">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: "30%" }}>Defense</th>
              <th>Mechanics</th>
            </tr>
          </thead>
          <tbody>
            {DEFENSES.map((d) => (
              <tr key={d.name}>
                <td>
                  <strong>{d.name}</strong>
                </td>
                <td>{d.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Callout title="Hardening recipe" kind="success">
          For runs whose green you need to trust:{" "}
          <code>limits.baseline: "strict"</code>, <code>specGuard: "error"</code>,{" "}
          <code>evaluatorGuard: "error"</code>, keep the spec <em>outside</em> the workspace when
          possible, add <code>guard: ["test/"]</code> on bare-runner checks whose suites the agent must
          not touch, and set <code>maxCostUsd</code>/<code>maxTokens</code> so a stuck loop can't spend
          unbounded money.
        </Callout>
        <Callout title="What guards can and can't do" kind="warn">
          Guards detect <em>tampering with the measurement</em>. They cannot make a weak measurement
          strong: if your only check is "the file compiles", an agent can satisfy it without meeting the
          requirement, and no guard will complain. Trust flows from evaluator design (next module) —
          guards just keep the evaluators honest.
        </Callout>
      </Section>

      <Quiz
        moduleId="trust-model"
        questions={[
          {
            q: "With default settings, the agent edits the in-workspace spec mid-run and the criteria pass. Result?",
            options: [
              "Outcome spec-tampered, success: false",
              "success with a loud tamper warning (specGuard defaults to warn)",
              "The run aborts immediately when the edit happens",
              "The engine re-parses the new spec and uses it",
            ],
            answer: 1,
            explain:
              "Default specGuard is warn: green stands but carries the tamper caveat. Only specGuard: error converts it to spec-tampered. And the engine always evaluates the original in-memory spec — mid-run edits never take effect within the run.",
          },
          {
            q: "Why does evaluator-file auto-detection deliberately skip bare runners like `npm test`?",
            options: [
              "Parsing package.json is unreliable",
              "Watching the whole suite would flag the agent's own legitimate new tests as tampering",
              "Performance — hashing is too slow",
              "npm scripts can't touch test files",
            ],
            answer: 1,
            explain:
              "Task guidance tells the agent to ADD tests; hash-watching every test file would make that look like tampering. So auto-detection watches only files NAMED in commands, and you opt suites in explicitly with evaluators[].guard when the suite is a fixed contract.",
          },
          {
            q: "Both the spec AND a guarded test file were tampered, both guards set to error. Which outcome is reported?",
            options: ["evaluator-tampered", "spec-tampered", "error", "Both, joined with '+'"],
            answer: 1,
            explain:
              "Spec-tamper takes precedence when both fire — rewriting the whole contract outranks rewriting one check.",
          },
          {
            q: "Which attack currently produces NO warning at all on the tampered run?",
            options: [
              "Deleting the .loop.yaml from the workspace",
              "Editing a test file named in a command",
              "A driver fabricating changedFiles off-git",
              "Doing nothing while checks were already green",
            ],
            answer: 0,
            explain:
              "checkSpecTamper requires a new hash to exist (`if (now && …)`), so deletion isn't flagged — unlike the evaluator guard, where a missing watched file IS tampering. The other three all produce warnings or are neutralized.",
          },
          {
            q: "Why are guarded files also EXCLUDED from the work diff?",
            options: [
              "To speed up diffing",
              "So editing the checks can't masquerade as real work in the changed-files signal",
              "Because git can't diff them",
              "To keep feedback prompts short",
            ],
            answer: 1,
            explain:
              "Two independent uses of the same file set: hash-watch for tamper detection, and diff-exclusion so a run whose only 'work' was editing its own success criteria still trips the vacuous/no-op warning.",
          },
          {
            q: "What's the correct division of labor between guards and evaluators?",
            options: [
              "Guards make weak checks strong",
              "Evaluators measure the requirement; guards only keep those measurements from being tampered with",
              "Guards replace baselines",
              "Evaluators detect tampering; guards measure quality",
            ],
            answer: 1,
            explain:
              "Guards are integrity, not strength. A vacuous check passes untampered forever. The trust chain is: falsifiable evaluators (RED first) → integrity guards → change detection → honest warnings.",
          },
        ]}
      />
    </div>
  );
}
