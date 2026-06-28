import path from "node:path";
import { existsSync } from "node:fs";
import { isGitRepo } from "../core/workspace";
import type { LintFinding, SpecRule } from "./types";
import {
  commandEvaluators,
  effectiveCwd,
  hasProjectMarkers,
  isExistingProjectSpec,
} from "./analysis";

// Findings carry human-facing prose (messages/hints) and rule-id constants; the
// detection literal patterns below are data, not control flow. Mutating either
// yields equivalent/no-value mutants — the rules' *logic* is what the tests pin.
// Stryker disable StringLiteral
// Stryker disable Regex

const CREATE_RE = /\.create!?\b|\.new\b|INSERT\s+INTO/i;
const REQUEST_RE =
  /\b(?:get|post|put|patch|delete)\b|ActionDispatch|Rack::Test|integration|\bcurl\b|\bfetch\(|\bvisit\b|\brequest\b/i;
const MD_REF_RE = /\b[\w./-]+\.md\b/i;
const VAULT_RE = /\bvault\b/i;
const DOC_VERB_RE = /\b(?:update|create|refresh|touch|write|add)\b/i;

/** workspace doesn't exist yet (the engine will create it; flagged for visibility). */
const workdirMissing: SpecRule = {
  id: "SPEC-WORKDIR-MISSING",
  severity: "warn",
  preflight: true,
  run({ workdir }) {
    if (existsSync(workdir)) return [];
    return [
      {
        ruleId: "SPEC-WORKDIR-MISSING",
        severity: "warn",
        message: `workspace directory does not exist: ${workdir}`,
        path: "workspace.dir",
        hint: "It will be created on run. If the agent is meant to edit an existing project, double-check workspace.dir / base.",
      },
    ];
  },
};

/** the resolved workdir is not a real project, but the spec expects one. */
const workdirNotProject: SpecRule = {
  id: "SPEC-WORKDIR-NOT-PROJECT",
  severity: "error",
  preflight: true,
  run({ spec, workdir }) {
    if (!isExistingProjectSpec(spec)) return [];
    if (!existsSync(workdir)) return []; // SPEC-WORKDIR-MISSING covers this
    if (isGitRepo(workdir)) return [];
    if (hasProjectMarkers(workdir, spec.stack)) return [];
    const kind = spec.stack?.framework ?? spec.stack?.language ?? "project";
    return [
      {
        ruleId: "SPEC-WORKDIR-NOT-PROJECT",
        severity: "error",
        message: `resolved workspace "${workdir}" is not a git repo and has no ${kind} markers, but this spec expects an existing project`,
        path: "workspace.dir",
        hint: "workspace.dir and a batch `base` can both be relative and compound (e.g. ../.. applied twice). Point them at the project root.",
      },
    ];
  },
};

/** a command's leading binary is a project-local path that doesn't exist. */
const evalBinaryMissing: SpecRule = {
  id: "SPEC-EVAL-BINARY-MISSING",
  severity: "error",
  preflight: true,
  run({ spec, workdir }) {
    const findings: LintFinding[] = [];
    for (const e of commandEvaluators(spec)) {
      if (!e.facts.leadingBinaryIsLocal || !e.facts.leadingBinary) continue;
      const cwd = effectiveCwd(workdir, e.facts);
      const binPath = path.resolve(cwd, e.facts.leadingBinary);
      if (!existsSync(binPath)) {
        findings.push({
          ruleId: "SPEC-EVAL-BINARY-MISSING",
          severity: "error",
          message: `evaluator "${e.name}": command binary "${e.facts.leadingBinary}" not found at ${binPath}`,
          path: `evaluators[${e.index}].options.command`,
          hint: "The check can never run. Fix the path/workdir or the command.",
        });
      }
    }
    return findings;
  },
};

/** a command references a script/file that doesn't exist at its effective cwd. */
const evalFileMissing: SpecRule = {
  id: "SPEC-EVAL-FILE-MISSING",
  severity: "warn",
  preflight: true,
  run({ spec, workdir }) {
    const findings: LintFinding[] = [];
    for (const e of commandEvaluators(spec)) {
      const cwd = effectiveCwd(workdir, e.facts);
      for (const ref of e.facts.referencedFiles) {
        const filePath = path.resolve(cwd, ref);
        if (!existsSync(filePath)) {
          findings.push({
            ruleId: "SPEC-EVAL-FILE-MISSING",
            severity: "warn",
            message: `evaluator "${e.name}": references "${ref}" not found at ${filePath}`,
            path: `evaluators[${e.index}].options.command`,
            hint: "OK if the agent creates it during the run; otherwise the path/workdir is wrong.",
          });
        }
      }
    }
    return findings;
  },
};

/** destructive/stateful DB command run without a test env → mutates dev DB. */
const evalDestructiveEnv: SpecRule = {
  id: "SPEC-EVAL-DESTRUCTIVE-ENV",
  severity: "warn",
  preflight: false,
  run({ spec }) {
    const findings: LintFinding[] = [];
    for (const e of commandEvaluators(spec)) {
      if (e.facts.mutatesDb && !e.facts.envTest) {
        findings.push({
          ruleId: "SPEC-EVAL-DESTRUCTIVE-ENV",
          severity: "warn",
          message: `evaluator "${e.name}" mutates a database without a test env — it will alter your development data every iteration`,
          path: `evaluators[${e.index}].options.command`,
          hint: "Run against a test DB (e.g. RAILS_ENV=test + db:test:prepare) or transactional fixtures.",
        });
      }
    }
    return findings;
  },
};

/** multiple stateful evaluators that the engine runs concurrently → can race. */
const evalSharedResource: SpecRule = {
  id: "SPEC-EVAL-SHARED-RESOURCE",
  severity: "warn",
  preflight: false,
  run({ spec }) {
    const stateful = commandEvaluators(spec).filter((e) => e.facts.stateful);
    if (stateful.length < 2) return [];
    return [
      {
        ruleId: "SPEC-EVAL-SHARED-RESOURCE",
        severity: "warn",
        message: `${stateful.length} evaluators run stateful app/DB commands; the engine runs evaluators concurrently, so they can race on a shared database`,
        path: "evaluators",
        hint: "Make them independent, or run them serially (e.g. one ordered verify script).",
      },
    ];
  },
};

/** some evaluators `cd` to an absolute dir while others run bare → cwd-fragile. */
const evalCwdMixed: SpecRule = {
  id: "SPEC-EVAL-CWD-MIXED",
  severity: "warn",
  preflight: false,
  run({ spec }) {
    const evals = commandEvaluators(spec);
    const someAbsCd = evals.some((e) => e.facts.cdTargets.some((t) => path.isAbsolute(t)));
    const someBareLocal = evals.some(
      (e) => e.facts.cdTargets.length === 0 && e.facts.usesProjectBinstub,
    );
    if (!someAbsCd || !someBareLocal) return [];
    return [
      {
        ruleId: "SPEC-EVAL-CWD-MIXED",
        severity: "warn",
        message:
          "evaluators mix absolute `cd <dir> &&` with bare project commands; the bare ones depend on the resolved workdir",
        path: "evaluators",
        hint: "Pick one convention — usually a correct workspace.dir + bare commands.",
      },
    ];
  },
};

/** a smoke that creates records inline but never drives a real endpoint. */
const smokeSelfFulfilling: SpecRule = {
  id: "SPEC-SMOKE-SELF-FULFILLING",
  severity: "warn",
  preflight: false,
  run({ spec }) {
    const type = spec.task?.type;
    if (type !== "webapp" && type !== "api") return [];
    const findings: LintFinding[] = [];
    for (const e of commandEvaluators(spec)) {
      if (!/smoke/i.test(e.name)) continue;
      if (CREATE_RE.test(e.command) && !REQUEST_RE.test(e.command)) {
        findings.push({
          ruleId: "SPEC-SMOKE-SELF-FULFILLING",
          severity: "warn",
          message: `smoke "${e.name}" creates records directly but never issues a request/controller call — it may pass without exercising the feature`,
          path: `evaluators[${e.index}].options.command`,
          hint: "Drive the real endpoint (request/controller) and make sure the smoke fails before the feature exists.",
        });
      }
    }
    return findings;
  },
};

/** requirements ask the agent to update docs/a vault, but nothing verifies it. */
const reqUnverifiedArtifact: SpecRule = {
  id: "SPEC-REQ-UNVERIFIED-ARTIFACT",
  severity: "info",
  preflight: false,
  run({ spec }) {
    const req = spec.requirements ?? "";
    const mentionsDoc = (MD_REF_RE.test(req) || VAULT_RE.test(req)) && DOC_VERB_RE.test(req);
    if (!mentionsDoc) return [];
    const anyChecksDoc = commandEvaluators(spec).some((e) => /\.md\b|vault/i.test(e.command));
    if (anyChecksDoc) return [];
    return [
      {
        ruleId: "SPEC-REQ-UNVERIFIED-ARTIFACT",
        severity: "info",
        message:
          "requirements ask the agent to update docs/a vault, but no evaluator verifies it — that step is unchecked",
        path: "requirements",
        hint: "Add an evaluator that checks the artifact exists, or drop it from the success contract.",
      },
    ];
  },
};

/** a spec with a smoke but no baseline can't detect vacuous checks. */
const baselineRecommended: SpecRule = {
  id: "SPEC-BASELINE-RECOMMENDED",
  severity: "info",
  preflight: false,
  run({ spec }) {
    if (spec.limits.baseline) return [];
    if (!commandEvaluators(spec).some((e) => /smoke/i.test(e.name))) return [];
    return [
      {
        ruleId: "SPEC-BASELINE-RECOMMENDED",
        severity: "info",
        message: "no baseline evaluation; a smoke that already passes before any agent work is likely vacuous",
        path: "limits.baseline",
        hint: "Set limits.baseline: true to catch checks that pass before the feature is built.",
      },
    ];
  },
};

export const SPEC_RULES: SpecRule[] = [
  workdirMissing,
  workdirNotProject,
  evalBinaryMissing,
  evalFileMissing,
  evalDestructiveEnv,
  evalSharedResource,
  evalCwdMixed,
  smokeSelfFulfilling,
  reqUnverifiedArtifact,
  baselineRecommended,
];

/** Rule ids that also run inside the engine's run-path preflight. */
export const PREFLIGHT_RULE_IDS: ReadonlySet<string> = new Set(
  SPEC_RULES.filter((r) => r.preflight).map((r) => r.id),
);
