import { describe, expect, it } from "vitest";
import { bindManifestChecks, unmappedEvaluatorsWarning } from "../src/check-validation/bind";
import { parseChecksManifest, type ChecksManifest } from "../src/check-validation/manifest";
import type { SpecEvaluator } from "../src/core/spec";

function manifest(over: Record<string, unknown> = {}): ChecksManifest {
  return parseChecksManifest({
    version: 1,
    name: "n",
    goal: "g",
    claims: [{ id: "claim", description: "d", checks: ["correct"] }],
    checks: [{ id: "correct", command: "node check.cjs", timeoutMs: 1000, rejectExitCodes: [10] }],
    control: { dir: "good" },
    counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
    ...over,
  });
}

function ev(over: Partial<SpecEvaluator> = {}, options: Record<string, unknown> = {}): SpecEvaluator {
  return {
    uses: "command",
    as: "correct",
    ...over,
    options: { command: "node check.cjs", timeoutMs: 1000, ...options },
  };
}

describe("bindManifestChecks", () => {
  it("binds a matching command evaluator and lists uncovered aliases", () => {
    const extra: SpecEvaluator = {
      uses: "command",
      as: "lint",
      options: { command: "true" },
    };
    const result = bindManifestChecks(manifest(), [ev(), extra]);
    expect(result.errors).toEqual([]);
    expect(result.unmapped).toEqual(["lint"]);
  });

  it("uses `uses` as the alias when `as` is omitted", () => {
    const m = manifest({
      checks: [{ id: "command", command: "node check.cjs", timeoutMs: 1000, rejectExitCodes: [10] }],
      claims: [{ id: "claim", description: "d", checks: ["command"] }],
    });
    const result = bindManifestChecks(m, [{ uses: "command", options: { command: "node check.cjs", timeoutMs: 1000 } }]);
    expect(result.errors).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  it("treats omitted options as empty and still requires an explicit timeout", () => {
    const result = bindManifestChecks(manifest(), [{ uses: "command", as: "correct" } as SpecEvaluator]);
    expect(result.errors.join("\n")).toMatch(/command does not match/);
    expect(result.errors.join("\n")).toMatch(/explicit timeoutMs matching 1000/);
  });

  it("rejects a check with no matching evaluator", () => {
    const result = bindManifestChecks(manifest(), [ev({ as: "other" })]);
    expect(result.errors).toEqual([
      'check validation: check "correct" is not bound to a command evaluator (need matching alias `as` or `uses`)',
    ]);
    expect(result.unmapped).toEqual(["other"]);
  });

  it("rejects a non-command evaluator even when the alias matches", () => {
    const result = bindManifestChecks(manifest(), [ev({ uses: "experiment" })]);
    expect(result.errors).toEqual([
      'check validation: check "correct" matches non-command evaluator "correct" (uses: experiment); only command evaluators can satisfy manifest checks',
    ]);
    expect(result.unmapped).toEqual(["correct"]);
  });

  it("rejects duplicate evaluator aliases before considering a unique binding", () => {
    const result = bindManifestChecks(manifest(), [ev(), ev()]);
    expect(result.errors).toEqual(['check validation: duplicate evaluator alias "correct"']);
    expect(result.unmapped).toEqual(["correct"]);
  });

  it("allows root cwd sentinels and an empty env / explicit exit 0", () => {
    for (const cwd of [undefined, "", ".", "./"]) {
      const result = bindManifestChecks(manifest(), [
        ev({}, { ...(cwd === undefined ? {} : { cwd }), env: {}, expectExitCode: 0 }),
      ]);
      expect(result.errors, `cwd=${String(cwd)}`).toEqual([]);
    }
  });

  it.each([
    ["nested", "has a non-root cwd"],
    [1, "has a non-root cwd"],
  ])("rejects non-root cwd %j", (cwd, snippet) => {
    const result = bindManifestChecks(manifest(), [ev({}, { cwd })]);
    expect(result.errors.join("\n")).toMatch(snippet);
  });

  it("rejects null cwd as invalid rather than default-equivalent", () => {
    const result = bindManifestChecks(manifest(), [ev({}, { cwd: null })]);
    expect(result.errors).toEqual([
      'check validation: evaluator "correct" cwd is null which is invalid for the command evaluator schema (omit the field for the default); cannot bind to check "correct"',
    ]);
  });

  it("rejects a nonempty env, an array env, and a non-object env", () => {
    expect(bindManifestChecks(manifest(), [ev({}, { env: { SPECIAL: "1" } })]).errors.join("\n")).toMatch(
      /has a nonempty env/,
    );
    expect(bindManifestChecks(manifest(), [ev({}, { env: ["x"] })]).errors.join("\n")).toMatch(/has a nonempty env/);
    expect(bindManifestChecks(manifest(), [ev({}, { env: "nope" })]).errors.join("\n")).toMatch(/has a nonempty env/);
  });

  it("rejects null env as invalid rather than default-equivalent", () => {
    const result = bindManifestChecks(manifest(), [ev({}, { env: null })]);
    expect(result.errors).toEqual([
      'check validation: evaluator "correct" env is null which is invalid for the command evaluator schema (omit the field for the default); cannot bind to check "correct"',
    ]);
  });

  it("rejects a non-zero expectExitCode and a non-numeric stand-in", () => {
    expect(bindManifestChecks(manifest(), [ev({}, { expectExitCode: 10 })]).errors.join("\n")).toMatch(
      /expectExitCode is not 0/,
    );
    expect(bindManifestChecks(manifest(), [ev({}, { expectExitCode: "0" })]).errors.join("\n")).toMatch(
      /expectExitCode is not 0/,
    );
  });

  it("rejects null expectExitCode as invalid rather than default-equivalent", () => {
    const result = bindManifestChecks(manifest(), [ev({}, { expectExitCode: null })]);
    expect(result.errors).toEqual([
      'check validation: evaluator "correct" expectExitCode is null which is invalid for the command evaluator schema (omit the field or set 0); cannot bind to check "correct"',
    ]);
  });

  it.each(["scoreRegex", "scoreGte", "scoreLte"])("rejects %s score constraints", (key) => {
    const result = bindManifestChecks(manifest(), [ev({}, { [key]: key === "scoreRegex" ? "(.*)" : 1 })]);
    expect(result.errors.join("\n")).toMatch(/score constraints/);
  });

  it("rejects a command mismatch", () => {
    const result = bindManifestChecks(manifest(), [ev({}, { command: "node other.cjs" })]);
    expect(result.errors).toEqual([
      'check validation: check "correct" command does not match evaluator "correct"',
    ]);
  });

  it.each([undefined, "1000", Number.NaN, Number.POSITIVE_INFINITY])(
    "requires a finite numeric timeoutMs (got %s)",
    (timeoutMs) => {
      const options: Record<string, unknown> = { command: "node check.cjs" };
      if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
      const result = bindManifestChecks(manifest(), [{ uses: "command", as: "correct", options }]);
      expect(result.errors.join("\n")).toMatch(/explicit timeoutMs matching 1000/);
    },
  );

  it("rejects a finite timeout that does not equal the check", () => {
    const result = bindManifestChecks(manifest(), [ev({}, { timeoutMs: 2000 })]);
    expect(result.errors).toEqual([
      'check validation: check "correct" timeoutMs 1000 does not match evaluator "correct" timeoutMs 2000',
    ]);
  });

  it("collects every incompatibility for one check", () => {
    const result = bindManifestChecks(manifest(), [
      ev(
        {},
        {
          command: "other",
          timeoutMs: 5,
          cwd: "nested",
          env: { A: "1" },
          expectExitCode: 2,
          scoreRegex: "x",
          scoreGte: 1,
          scoreLte: 2,
        },
      ),
    ]);
    expect(result.errors.length).toBe(6);
  });

  it("binds each of several checks independently", () => {
    const m = manifest({
      checks: [
        { id: "a", command: "true", timeoutMs: 1000, rejectExitCodes: [1] },
        { id: "b", command: "false", timeoutMs: 2000, rejectExitCodes: [1] },
      ],
      claims: [{ id: "claim", description: "d", checks: ["a", "b"] }],
    });
    const result = bindManifestChecks(m, [
      { uses: "command", as: "a", options: { command: "true", timeoutMs: 1000 } },
      { uses: "command", as: "b", options: { command: "false", timeoutMs: 2000 } },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });
});

describe("unmappedEvaluatorsWarning", () => {
  it("names every uncovered evaluator alias", () => {
    expect(unmappedEvaluatorsWarning(["lint", "types"])).toBe(
      "check validation did not cover evaluator(s): lint, types",
    );
  });
});
