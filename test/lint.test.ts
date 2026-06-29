import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSpec } from "../src/core/spec";
import { parseBatchManifest } from "../src/batch/manifest";
import { lintSpec, lintBatch, lintPath, workspacePreflight } from "../src/lint";
import { analyzeCommand, effectiveCwd, isExistingProjectSpec } from "../src/lint/analysis";

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "loopgen-lint-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spec = (over: Record<string, unknown>) =>
  parseSpec({ name: "t", requirements: "do it", driver: { uses: "mock" }, ...over });

/** ids present in a finding list */
const ids = (findings: { ruleId: string }[]) => findings.map((f) => f.ruleId);

// ---------------------------------------------------------------------------
describe("analyzeCommand", () => {
  it("captures cd target, local binstub, and db mutation", () => {
    const f = analyzeCommand("cd /abs/proj && bin/rails db:seed");
    expect(f.cdTargets).toEqual(["/abs/proj"]);
    expect(f.leadingBinary).toBe("bin/rails");
    expect(f.leadingBinaryIsLocal).toBe(true);
    expect(f.usesProjectBinstub).toBe(true);
    expect(f.mutatesDb).toBe(true);
    expect(f.stateful).toBe(true);
    expect(f.envTest).toBe(false);
  });

  it("detects a pinned test env and still sees the db op", () => {
    const f = analyzeCommand("RAILS_ENV=test bin/rails db:test:prepare");
    expect(f.envTest).toBe(true);
    expect(f.mutatesDb).toBe(true);
    expect(f.leadingBinary).toBe("bin/rails");
  });

  it("extracts a referenced runner script but ignores a quoted inline body", () => {
    expect(analyzeCommand("bin/rails runner script/x.rb").referencedFiles).toEqual(["script/x.rb"]);
    expect(analyzeCommand("node solution.js").referencedFiles).toEqual(["solution.js"]);
    // inline heredoc-style: the arg is a quote, not a path
    expect(analyzeCommand("bin/rails runner '\n  u.create!\n'").referencedFiles).toEqual([]);
  });

  it("treats PATH tools as non-local and non-stateful", () => {
    const f = analyzeCommand("npm test");
    expect(f.leadingBinary).toBe("npm");
    expect(f.leadingBinaryIsLocal).toBe(false);
    expect(f.usesProjectBinstub).toBe(false);
    expect(f.stateful).toBe(false);
  });

  it("flags destroy_all as a db mutation", () => {
    expect(analyzeCommand("bin/rails runner 'User.destroy_all'").mutatesDb).toBe(true);
  });

  it("effectiveCwd uses the last cd target, else the workdir", () => {
    expect(effectiveCwd("/w", analyzeCommand("bin/rails test"))).toBe("/w");
    expect(effectiveCwd("/w", analyzeCommand("cd /abs && bin/rails test"))).toBe("/abs");
  });

  it("distinguishes local vs PATH binaries and detects bundler / NODE_ENV", () => {
    expect(analyzeCommand("./bin/x").leadingBinaryIsLocal).toBe(true);
    expect(analyzeCommand("/usr/local/bin/foo").leadingBinaryIsLocal).toBe(true);
    expect(analyzeCommand("pytest").leadingBinaryIsLocal).toBe(false);
    expect(analyzeCommand("bundle exec rspec").usesProjectBinstub).toBe(true);
    expect(analyzeCommand("NODE_ENV=test node x").envTest).toBe(true);
    expect(analyzeCommand("A=1 B=2 node x.js").leadingBinary).toBe("node");
  });

  it("mutatesDb only for db/destructive ops; bare rails is still stateful", () => {
    expect(analyzeCommand("bin/rails test").mutatesDb).toBe(false);
    expect(analyzeCommand("bin/rails db:migrate").mutatesDb).toBe(true);
    expect(analyzeCommand("rails server").stateful).toBe(true);
    expect(analyzeCommand("npm run build").stateful).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("isExistingProjectSpec", () => {
  it("is true for snapshot:git or a binstub-using evaluator", () => {
    expect(isExistingProjectSpec(spec({ workspace: { dir: ".", snapshot: "git" } }))).toBe(true);
    expect(
      isExistingProjectSpec(spec({ evaluators: [{ uses: "command", as: "t", options: { command: "bin/rails test" } }] })),
    ).toBe(true);
  });
  it("is false for greenfield (PATH tools, no snapshot)", () => {
    expect(
      isExistingProjectSpec(spec({ evaluators: [{ uses: "command", as: "t", options: { command: "npm test" } }] })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("SPEC-WORKDIR rules", () => {
  it("warns when the workspace does not exist", () => {
    const found = lintSpec(spec({}), { workdir: path.join(dir, "nope") });
    expect(ids(found)).toContain("SPEC-WORKDIR-MISSING");
  });

  it("errors when a project-expecting spec resolves to a non-project dir", () => {
    const s = spec({
      stack: { language: "ruby", framework: "rails" },
      evaluators: [{ uses: "command", as: "t", options: { command: "bin/rails test" } }],
    });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-WORKDIR-NOT-PROJECT");
  });

  it("does not fire for greenfield specs", () => {
    const s = spec({
      stack: { language: "typescript" },
      evaluators: [{ uses: "command", as: "t", options: { command: "npm test" } }],
    });
    expect(ids(lintSpec(s, { workdir: dir }))).not.toContain("SPEC-WORKDIR-NOT-PROJECT");
  });

  it("passes when stack markers are present", () => {
    writeFileSync(path.join(dir, "Gemfile"), "source 'https://rubygems.org'\n");
    writeFileSync(path.join(dir, "bin"), ""); // ensure bin path collision doesn't matter
    rmSync(path.join(dir, "bin"));
    const s = spec({
      stack: { language: "ruby", framework: "rails" },
      workspace: { dir: ".", snapshot: "git" },
    });
    expect(ids(lintSpec(s, { workdir: dir }))).not.toContain("SPEC-WORKDIR-NOT-PROJECT");
  });

  it("passes when the workdir is a git repo", () => {
    execSync("git init -q", { cwd: dir });
    const s = spec({ stack: { language: "ruby", framework: "rails" }, workspace: { dir: ".", snapshot: "git" } });
    expect(ids(lintSpec(s, { workdir: dir }))).not.toContain("SPEC-WORKDIR-NOT-PROJECT");
  });

  it("recognizes node project markers", () => {
    const s = spec({ stack: { language: "node" }, workspace: { dir: ".", snapshot: "git" } });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-WORKDIR-NOT-PROJECT");
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(ids(lintSpec(s, { workdir: dir }))).not.toContain("SPEC-WORKDIR-NOT-PROJECT");
  });
});

// ---------------------------------------------------------------------------
describe("SPEC-EVAL rules", () => {
  it("errors on a missing project-local binary", () => {
    const s = spec({ evaluators: [{ uses: "command", as: "t", options: { command: "bin/rails test" } }] });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-EVAL-BINARY-MISSING");
  });

  it("no binary error when the binstub exists", () => {
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "rails"), "#!/bin/sh\n");
    const s = spec({ evaluators: [{ uses: "command", as: "t", options: { command: "bin/rails test" } }] });
    expect(ids(lintSpec(s, { workdir: dir }))).not.toContain("SPEC-EVAL-BINARY-MISSING");
  });

  it("warns on a referenced script that does not exist", () => {
    const s = spec({ evaluators: [{ uses: "command", as: "smoke", options: { command: "node script/x.js" } }] });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-EVAL-FILE-MISSING");
  });

  it("warns on a destructive command without a test env, but not with one", () => {
    const bad = spec({ evaluators: [{ uses: "command", as: "seed", options: { command: "bin/rails db:seed" } }] });
    expect(ids(lintSpec(bad, { workdir: dir }))).toContain("SPEC-EVAL-DESTRUCTIVE-ENV");
    const good = spec({
      evaluators: [{ uses: "command", as: "seed", options: { command: "RAILS_ENV=test bin/rails db:seed" } }],
    });
    expect(ids(lintSpec(good, { workdir: dir }))).not.toContain("SPEC-EVAL-DESTRUCTIVE-ENV");
  });

  it("warns when 2+ stateful evaluators will run concurrently", () => {
    const evaluators = [
      { uses: "command", as: "a", options: { command: "bin/rails test" } },
      { uses: "command", as: "b", options: { command: "bin/rails db:seed" } },
    ];
    // Opting into parallelism with stateful checks → race risk warning.
    const parallel = spec({ evaluation: { concurrency: 2 }, evaluators });
    expect(ids(lintSpec(parallel, { workdir: dir }))).toContain("SPEC-EVAL-SHARED-RESOURCE");
    // The default is sequential (concurrency: 1), which is safe → no warning.
    const sequential = spec({ evaluators });
    expect(ids(lintSpec(sequential, { workdir: dir }))).not.toContain("SPEC-EVAL-SHARED-RESOURCE");
  });

  it("warns on mixed absolute-cd vs bare project commands", () => {
    const s = spec({
      evaluators: [
        { uses: "command", as: "a", options: { command: "cd /abs && bin/rails test" } },
        { uses: "command", as: "b", options: { command: "bin/rails db:seed" } },
      ],
    });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-EVAL-CWD-MIXED");
  });
});

// ---------------------------------------------------------------------------
describe("SPEC-SMOKE-SELF-FULFILLING", () => {
  const smoke = (command: string, type = "webapp") =>
    spec({ task: { type }, evaluators: [{ uses: "command", as: "smoke", options: { command } }] });

  it("flags a webapp smoke that creates records but issues no request", () => {
    expect(ids(lintSpec(smoke("bin/rails runner 'Sale.create!(x: 1)'"), { workdir: dir }))).toContain(
      "SPEC-SMOKE-SELF-FULFILLING",
    );
  });
  it("does not flag when the smoke drives a request", () => {
    expect(ids(lintSpec(smoke("bin/rails runner 'post sales_path; Sale.create!'"), { workdir: dir }))).not.toContain(
      "SPEC-SMOKE-SELF-FULFILLING",
    );
  });
  it("does not flag non-webapp tasks", () => {
    expect(ids(lintSpec(smoke("ruby x.rb; Foo.create!", "function"), { workdir: dir }))).not.toContain(
      "SPEC-SMOKE-SELF-FULFILLING",
    );
  });
});

// ---------------------------------------------------------------------------
describe("info rules", () => {
  it("notes an unverified doc/vault artifact", () => {
    const s = spec({
      requirements: "Build it. After, update Current-Context.md in the vault.",
      evaluators: [{ uses: "command", as: "t", options: { command: "npm test" } }],
    });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-REQ-UNVERIFIED-ARTIFACT");
  });
  it("recommends a baseline when a smoke has none", () => {
    const s = spec({
      limits: { maxIterations: 3, baseline: false },
      evaluators: [{ uses: "command", as: "smoke", options: { command: "npm test" } }],
    });
    expect(ids(lintSpec(s, { workdir: dir }))).toContain("SPEC-BASELINE-RECOMMENDED");
  });
});

// ---------------------------------------------------------------------------
describe("workspacePreflight", () => {
  it("blocks (ok:false) on a non-project workdir", () => {
    const s = spec({
      stack: { language: "ruby", framework: "rails" },
      workspace: { dir: ".", snapshot: "git" },
    });
    const pf = workspacePreflight(s, dir);
    expect(pf.ok).toBe(false);
    expect(pf.errors?.join("\n")).toMatch(/SPEC-WORKDIR-NOT-PROJECT/);
  });

  it("passes a greenfield spec and surfaces only non-blocking notes", () => {
    const s = spec({ evaluators: [{ uses: "command", as: "smoke", options: { command: "node x.js" } }] });
    const pf = workspacePreflight(s, dir);
    expect(pf.ok).toBe(true);
    // referenced file missing is a warning, not a blocker
    expect(pf.warnings?.join("\n")).toMatch(/SPEC-EVAL-FILE-MISSING/);
  });

  it("excludes advisory (non-preflight) rules", () => {
    const s = spec({ evaluators: [{ uses: "command", as: "seed", options: { command: "bin/rails db:seed" } }] });
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "rails"), "");
    const pf = workspacePreflight(s, dir);
    const all = [...(pf.errors ?? []), ...(pf.warnings ?? []), ...(pf.notes ?? [])].join("\n");
    expect(all).not.toMatch(/SPEC-EVAL-DESTRUCTIVE-ENV/);
  });
});

// ---------------------------------------------------------------------------
describe("lintBatch", () => {
  const inlineItem = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    inline: {
      name: `${name}-spec`,
      requirements: "x",
      workspace: { dir: "." },
      driver: { uses: "mock" },
      evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
      limits: { maxIterations: 8 },
    },
    ...over,
  });

  it("flags maxIterations override, needs-as-ordering, and fail-fast chain", () => {
    const manifest = parseBatchManifest({
      name: "m",
      concurrency: 1,
      continueOnError: false,
      defaults: { maxIterations: 10 },
      items: [inlineItem("a"), inlineItem("b", { needs: ["a"] })],
    });
    const found = ids(lintBatch(manifest, { baseDir: dir }));
    expect(found).toContain("BATCH-MAXITER-OVERRIDE");
    expect(found).toContain("BATCH-NEEDS-AS-ORDERING");
    expect(found).toContain("BATCH-FAILFAST-CHAIN");
  });

  it("does not warn maxIterations when the item sets it or values already match", () => {
    const match = parseBatchManifest({ defaults: { maxIterations: 8 }, items: [inlineItem("a")] });
    expect(ids(lintBatch(match, { baseDir: dir }))).not.toContain("BATCH-MAXITER-OVERRIDE");
    const explicit = parseBatchManifest({
      defaults: { maxIterations: 10 },
      items: [inlineItem("a", { maxIterations: 5 })],
    });
    expect(ids(lintBatch(explicit, { baseDir: dir }))).not.toContain("BATCH-MAXITER-OVERRIDE");
  });

  it("does not warn needs-as-ordering at concurrency 2, without needs, or across workspaces", () => {
    const conc2 = parseBatchManifest({ concurrency: 2, items: [inlineItem("a"), inlineItem("b", { needs: ["a"] })] });
    expect(ids(lintBatch(conc2, { baseDir: dir }))).not.toContain("BATCH-NEEDS-AS-ORDERING");
    const noNeeds = parseBatchManifest({ items: [inlineItem("a"), inlineItem("b")] });
    expect(ids(lintBatch(noNeeds, { baseDir: dir }))).not.toContain("BATCH-NEEDS-AS-ORDERING");
    const diffWs = parseBatchManifest({
      items: [
        inlineItem("a"),
        {
          name: "b",
          needs: ["a"],
          inline: {
            name: "b-spec",
            requirements: "x",
            workspace: { dir: "sub" },
            driver: { uses: "mock" },
            evaluators: [{ uses: "command", as: "c", options: { command: "true" } }],
            limits: { maxIterations: 8 },
          },
        },
      ],
    });
    expect(ids(lintBatch(diffWs, { baseDir: dir }))).not.toContain("BATCH-NEEDS-AS-ORDERING");
  });

  it("does not warn fail-fast when continueOnError is true", () => {
    const m = parseBatchManifest({ continueOnError: true, items: [inlineItem("a"), inlineItem("b")] });
    expect(ids(lintBatch(m, { baseDir: dir }))).not.toContain("BATCH-FAILFAST-CHAIN");
  });

  it("reports a missing spec file as a load error", () => {
    const manifest = parseBatchManifest({ items: [{ name: "x", spec: "nope.loop.yaml" }] });
    const found = lintBatch(manifest, { baseDir: dir });
    expect(ids(found)).toContain("BATCH-SPEC-LOAD");
    expect(found.find((f) => f.ruleId === "BATCH-SPEC-LOAD")!.item).toBe("x");
  });

  it("tags per-item spec findings with the item name", () => {
    const manifest = parseBatchManifest({
      items: [inlineItem("solo", { inline: { name: "s", requirements: "x", workspace: { dir: "." }, driver: { uses: "mock" }, evaluators: [{ uses: "command", as: "smoke", options: { command: "node missing.js" } }], limits: { maxIterations: 1 } } })],
    });
    const found = lintBatch(manifest, { baseDir: dir });
    const fileMiss = found.find((f) => f.ruleId === "SPEC-EVAL-FILE-MISSING");
    expect(fileMiss?.item).toBe("solo");
  });
});

// ---------------------------------------------------------------------------
describe("lintPath", () => {
  it("dispatches a spec file and reproduces a compounded-path miss", () => {
    const slices = path.join(dir, "loops", "slices");
    mkdirSync(slices, { recursive: true });
    const file = path.join(slices, "x.loop.yaml");
    writeFileSync(
      file,
      [
        "name: x",
        "requirements: do it",
        "stack: { language: ruby, framework: rails }",
        "workspace: { dir: ../.. }", // compounds above the (non-project) tmp dir
        "driver: { uses: mock }",
        "evaluators: [{ uses: command, as: t, options: { command: 'bin/rails test' } }]",
      ].join("\n"),
    );
    const res = lintPath(file);
    expect(res.kind).toBe("spec");
    expect(ids(res.findings)).toContain("SPEC-WORKDIR-NOT-PROJECT");
  });

  it("dispatches a batch file", () => {
    const file = path.join(dir, "m.batch.yaml");
    writeFileSync(
      file,
      [
        "name: m",
        "items:",
        "  - name: a",
        "    inline:",
        "      name: a",
        "      requirements: x",
        "      workspace: { dir: . }",
        "      driver: { uses: mock }",
        "      evaluators: [{ uses: command, as: c, options: { command: 'true' } }]",
        "      limits: { maxIterations: 1 }",
      ].join("\n"),
    );
    const res = lintPath(file);
    expect(res.kind).toBe("batch");
  });
});
