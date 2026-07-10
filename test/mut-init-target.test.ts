import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  initTarget,
  listTargetTemplates,
  resolveTargetTemplate,
  type TargetTemplateMeta,
} from "../src/scaffold/init-target";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "loopgen-mut-init-"));
  dirs.push(d);
  return d;
}

/** Scaffold a template into a fresh dir (no git) and return the dest path. */
function scaffold(id: string): string {
  const dest = path.join(tmp(), "target");
  initTarget(id, { dest, git: false });
  return dest;
}

function read(dest: string, rel: string): string {
  return readFileSync(path.join(dest, rel), "utf8");
}

function readJson(dest: string, rel: string): Record<string, unknown> {
  return JSON.parse(read(dest, rel)) as Record<string, unknown>;
}

const DEV_DEPS = { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" };

// ---------------------------------------------------------------------------
// Template metadata (listTargetTemplates) — pins descriptions + examples arrays
// ---------------------------------------------------------------------------

describe("listTargetTemplates metadata (exact)", () => {
  const byId = (): Map<string, TargetTemplateMeta> =>
    new Map(listTargetTemplates().map((m) => [m.id, m]));

  it("returns exactly the seven templates in insertion order", () => {
    expect(listTargetTemplates().map((t) => t.id)).toEqual([
      "fizzbuzz",
      "fetch-user",
      "api-orders",
      "ralph",
      "experiment-ab",
      "evaluator-optimizer",
      "osmani",
    ]);
  });

  it("fizzbuzz meta is exact", () => {
    expect(byId().get("fizzbuzz")).toEqual({
      id: "fizzbuzz",
      description: "TypeScript fizzbuzz stub + failing tests (function-fizzbuzz)",
      examples: ["examples/building-blocks/function-fizzbuzz.loop.yaml"],
    });
  });

  it("fetch-user meta is exact", () => {
    expect(byId().get("fetch-user")).toEqual({
      id: "fetch-user",
      description: "TypeScript fetchUser without backoff + RED retry tests (copilot/opencode)",
      examples: [
        "examples/building-blocks/copilot-feature.loop.yaml",
        "examples/building-blocks/opencode-feature.loop.yaml",
      ],
    });
  });

  it("api-orders meta is exact", () => {
    expect(byId().get("api-orders")).toEqual({
      id: "api-orders",
      description: "Minimal Express app without GET /orders (api-feature-grok)",
      examples: ["examples/building-blocks/api-feature-grok.loop.yaml"],
    });
  });

  it("ralph meta is exact", () => {
    expect(byId().get("ralph")).toEqual({
      id: "ralph",
      description: "Tiny math stubs + fix_plan.md checklist (ralph-loop)",
      examples: ["examples/patterns/ralph-loop.loop.yaml"],
    });
  });

  it("experiment-ab meta is exact", () => {
    expect(byId().get("experiment-ab")).toEqual({
      id: "experiment-ab",
      description: "Offline A/B sim with RED conversion metric (experiment-ab)",
      examples: ["examples/building-blocks/experiment-ab.loop.yaml"],
    });
  });

  it("evaluator-optimizer meta is exact", () => {
    expect(byId().get("evaluator-optimizer")).toEqual({
      id: "evaluator-optimizer",
      description: "fetchWithRetry stub + high p95 bench (evaluator-optimizer)",
      examples: ["examples/patterns/evaluator-optimizer.loop.yaml"],
    });
  });

  it("osmani meta is exact", () => {
    expect(byId().get("osmani")).toEqual({
      id: "osmani",
      description: "Math lib with TODO multiply + coverage gate (osmani-harness)",
      examples: ["examples/patterns/osmani-harness.batch.yaml"],
    });
  });
});

// ---------------------------------------------------------------------------
// resolveTargetTemplate — every branch + every alias
// ---------------------------------------------------------------------------

describe("resolveTargetTemplate branches", () => {
  it("exact id match returns the id (TEMPLATES[raw])", () => {
    for (const id of [
      "fizzbuzz",
      "fetch-user",
      "api-orders",
      "ralph",
      "experiment-ab",
      "evaluator-optimizer",
      "osmani",
    ]) {
      expect(resolveTargetTemplate(id)).toBe(id);
    }
  });

  it("trims surrounding whitespace before matching (raw.trim())", () => {
    expect(resolveTargetTemplate("  fizzbuzz  ")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("\tralph\n")).toBe("ralph");
  });

  it("empty and whitespace-only input returns null (!raw guard)", () => {
    expect(resolveTargetTemplate("")).toBeNull();
    expect(resolveTargetTemplate("   ")).toBeNull();
    expect(resolveTargetTemplate("\t\n")).toBeNull();
  });

  it("basename match: a path whose basename is an id resolves (TEMPLATES[base])", () => {
    expect(resolveTargetTemplate("some/dir/fizzbuzz")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("/abs/path/api-orders")).toBe("api-orders");
  });

  it("alias-by-basename resolves (EXAMPLE_ALIASES[base])", () => {
    expect(resolveTargetTemplate("examples/building-blocks/function-fizzbuzz.loop.yaml")).toBe(
      "fizzbuzz",
    );
    expect(resolveTargetTemplate("examples/building-blocks/copilot-feature.loop.yaml")).toBe(
      "fetch-user",
    );
    expect(resolveTargetTemplate("dir/osmani-harness.batch.yaml")).toBe("osmani");
  });

  it("alias-by-raw resolves when the whole string is a bare alias (EXAMPLE_ALIASES[raw])", () => {
    // These bare aliases equal their own basename, so pin them and also the
    // ones whose stripped form differs.
    expect(resolveTargetTemplate("function-fizzbuzz")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("copilot-feature")).toBe("fetch-user");
    expect(resolveTargetTemplate("opencode-feature")).toBe("fetch-user");
    expect(resolveTargetTemplate("api-feature-grok")).toBe("api-orders");
    expect(resolveTargetTemplate("ralph-loop")).toBe("ralph");
    expect(resolveTargetTemplate("evaluator-optimizer")).toBe("evaluator-optimizer");
    expect(resolveTargetTemplate("osmani-harness")).toBe("osmani");
  });

  it("every EXAMPLE_ALIASES entry resolves to the right id", () => {
    const cases: Record<string, string> = {
      "function-fizzbuzz": "fizzbuzz",
      "function-fizzbuzz.loop.yaml": "fizzbuzz",
      "copilot-feature": "fetch-user",
      "copilot-feature.loop.yaml": "fetch-user",
      "opencode-feature": "fetch-user",
      "opencode-feature.loop.yaml": "fetch-user",
      "api-feature-grok": "api-orders",
      "api-feature-grok.loop.yaml": "api-orders",
      "ralph-loop": "ralph",
      "ralph-loop.loop.yaml": "ralph",
      "experiment-ab": "experiment-ab",
      "experiment-ab.loop.yaml": "experiment-ab",
      "evaluator-optimizer": "evaluator-optimizer",
      "evaluator-optimizer.loop.yaml": "evaluator-optimizer",
      "osmani-harness": "osmani",
      "osmani-harness.batch.yaml": "osmani",
    };
    for (const [alias, id] of Object.entries(cases)) {
      expect(resolveTargetTemplate(alias)).toBe(id);
    }
  });

  it("strip regex handles .loop.yaml AND .batch.yaml suffixes (TEMPLATES[stripped])", () => {
    // A path whose basename is `<id>.loop.yaml` where <id> is a template id but
    // NOT an alias key — only the strip branch (TEMPLATES[stripped]) resolves it.
    expect(resolveTargetTemplate("some/dir/fizzbuzz.loop.yaml")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("some/dir/ralph.batch.yaml")).toBe("ralph");
    expect(resolveTargetTemplate("fetch-user.loop.yaml")).toBe("fetch-user");
  });

  it("strip regex + alias: stripped basename resolves via EXAMPLE_ALIASES[stripped]", () => {
    // `copilot-feature.batch.yaml` is not a literal alias key (only the .loop.yaml
    // variant is), and stripped `copilot-feature` is not a template id — so only
    // EXAMPLE_ALIASES[stripped] can resolve it.
    expect(resolveTargetTemplate("copilot-feature.batch.yaml")).toBe("fetch-user");
    expect(resolveTargetTemplate("api-feature-grok.batch.yaml")).toBe("api-orders");
  });

  it(".loop.yaml suffix that is NOT anchored at end must not strip mid-string", () => {
    // The regex is anchored ($). A basename with .loop.yaml in the middle should
    // not be stripped and should therefore not resolve.
    expect(resolveTargetTemplate("fizzbuzz.loop.yaml.bak")).toBeNull();
  });

  it("unknown input returns null (all branches fall through)", () => {
    expect(resolveTargetTemplate("nope")).toBeNull();
    expect(resolveTargetTemplate("totally-unknown.loop.yaml")).toBeNull();
    expect(resolveTargetTemplate("dir/unknown.batch.yaml")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tsconfig.json — shared across templates, pins compilerOptions exact values
// ---------------------------------------------------------------------------

describe("tsconfig.json contents (exact)", () => {
  it("has the exact compilerOptions and include", () => {
    const dest = scaffold("fizzbuzz");
    const cfg = readJson(dest, "tsconfig.json");
    expect(cfg).toEqual({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        types: ["node"],
      },
      include: ["src/**/*", "test/**/*"],
    });
  });

  it("ends with a trailing newline", () => {
    const dest = scaffold("fizzbuzz");
    expect(read(dest, "tsconfig.json").endsWith("\n")).toBe(true);
    // tsconfig is not emitted for experiment-ab (only .mjs template), so verify
    // it IS emitted for the ts templates that include it.
    expect(existsSync(path.join(scaffold("osmani"), "tsconfig.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fizzbuzz template
// ---------------------------------------------------------------------------

describe("fizzbuzz template files", () => {
  it("package.json is exact", () => {
    const dest = scaffold("fizzbuzz");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-fizzbuzz",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test src/fizzbuzz.test.ts",
        typecheck: "tsc --noEmit",
      },
      devDependencies: DEV_DEPS,
    });
    expect(read(dest, "package.json").endsWith("\n")).toBe(true);
  });

  it("src/fizzbuzz.ts is the RED stub", () => {
    const src = read(scaffold("fizzbuzz"), "src/fizzbuzz.ts");
    expect(src).toContain(
      "/** RED stub — implement fizzbuzz(n) as described in the loop requirements. */",
    );
    expect(src).toContain("export function fizzbuzz(_n: number): string[] {");
    expect(src).toContain('throw new Error("fizzbuzz not implemented");');
  });

  it("src/fizzbuzz.test.ts pins the exact expectations", () => {
    const t = read(scaffold("fizzbuzz"), "src/fizzbuzz.test.ts");
    expect(t).toContain('import { fizzbuzz } from "./fizzbuzz.ts";');
    expect(t).toContain('test("n=0 returns empty array", () => {');
    expect(t).toContain("assert.deepEqual(fizzbuzz(0), []);");
    expect(t).toContain('test("maps 1..15 with Fizz/Buzz/FizzBuzz", () => {');
    expect(t).toContain("const out = fizzbuzz(15);");
    expect(t).toContain('assert.equal(out[2], "Fizz");');
    expect(t).toContain('assert.equal(out[4], "Buzz");');
    expect(t).toContain('assert.equal(out[14], "FizzBuzz");');
    expect(t).toContain('assert.equal(out[0], "1");');
  });

  it("README.md names the fizzbuzz example spec", () => {
    const r = read(scaffold("fizzbuzz"), "README.md");
    expect(r).toContain("# fizzbuzz target (RED)");
    expect(r).toContain(
      "npm run loopgen -- run examples/building-blocks/function-fizzbuzz.loop.yaml",
    );
  });
});

// ---------------------------------------------------------------------------
// fetch-user template
// ---------------------------------------------------------------------------

describe("fetch-user template files", () => {
  it("package.json is exact (glob test script)", () => {
    const dest = scaffold("fetch-user");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-fetch-user",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test test/**/*.test.ts",
        typecheck: "tsc --noEmit",
      },
      devDependencies: DEV_DEPS,
    });
  });

  it("src/fetchUser.ts is the single-shot RED stub", () => {
    const src = read(scaffold("fetch-user"), "src/fetchUser.ts");
    expect(src).toContain("export type FetchUserOpts = { fetchImpl?: typeof fetch };");
    expect(src).toContain("/** RED stub — single-shot fetch with no retries. */");
    expect(src).toContain(
      "export async function fetchUser(url: string, opts: FetchUserOpts = {}): Promise<unknown> {",
    );
    expect(src).toContain("const f = opts.fetchImpl ?? fetch;");
    expect(src).toContain("const res = await f(url);");
    expect(src).toContain("if (!res.ok) throw new Error(`HTTP ${res.status}`);");
    expect(src).toContain("return res.json();");
  });

  it("test/fetchUser.backoff.test.ts pins the retry expectations", () => {
    const t = read(scaffold("fetch-user"), "test/fetchUser.backoff.test.ts");
    expect(t).toContain('import { fetchUser } from "../src/fetchUser.ts";');
    expect(t).toContain('test("succeeds after a transient 5xx", async () => {');
    expect(t).toContain('if (n < 3) return new Response("nope", { status: 503 });');
    expect(t).toContain("return Response.json({ id: 1 });");
    expect(t).toContain("assert.deepEqual(body, { id: 1 });");
    expect(t).toContain("assert.equal(n, 3);");
    expect(t).toContain('test("does not retry 4xx", async () => {');
    expect(t).toContain('return new Response("nope", { status: 404 });');
    expect(t).toContain("assert.equal(n, 1);");
  });

  it("README.md names copilot-feature", () => {
    const r = read(scaffold("fetch-user"), "README.md");
    expect(r).toContain("# fetchUser target (RED)");
    expect(r).toContain(
      "npm run loopgen -- run examples/building-blocks/copilot-feature.loop.yaml -d claude-agent-sdk",
    );
  });
});

// ---------------------------------------------------------------------------
// api-orders template
// ---------------------------------------------------------------------------

describe("api-orders template files", () => {
  it("package.json is exact (express dep + supertest devDeps)", () => {
    const dest = scaffold("api-orders");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-api-orders",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test test/**/*.test.ts",
        typecheck: "tsc --noEmit",
      },
      dependencies: { express: "^4.21.0" },
      devDependencies: {
        tsx: "^4.19.2",
        typescript: "^5.7.2",
        "@types/node": "^22.10.0",
        "@types/express": "^4.17.21",
        "@types/supertest": "^6.0.2",
        supertest: "^7.0.0",
      },
    });
  });

  it("src/app.ts has /health but not /orders", () => {
    const src = read(scaffold("api-orders"), "src/app.ts");
    expect(src).toContain('import express from "express";');
    expect(src).toContain("export function createApp() {");
    expect(src).toContain("const app = express();");
    expect(src).toContain('app.get("/health", (_req, res) => res.json({ ok: true }));');
    expect(src).toContain("// RED: GET /orders is missing — the loop agent should add it.");
    expect(src).toContain("return app;");
  });

  it("test/orders.test.ts pins the expectations", () => {
    const t = read(scaffold("api-orders"), "test/orders.test.ts");
    expect(t).toContain('import request from "supertest";');
    expect(t).toContain('import { createApp } from "../src/app.ts";');
    expect(t).toContain('test("GET /orders is implemented", async () => {');
    expect(t).toContain('const res = await request(createApp()).get("/orders");');
    expect(t).toContain("assert.equal(res.status, 200);");
    expect(t).toContain("assert.ok(Array.isArray(res.body.data));");
  });

  it("README.md describes api-orders", () => {
    const r = read(scaffold("api-orders"), "README.md");
    expect(r).toContain("# api-orders target (RED)");
    expect(r).toContain("Express app without GET /orders.");
  });
});

// ---------------------------------------------------------------------------
// ralph template
// ---------------------------------------------------------------------------

describe("ralph template files", () => {
  it("package.json is exact", () => {
    const dest = scaffold("ralph");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-ralph",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test test/**/*.test.ts",
        typecheck: "tsc --noEmit",
      },
      devDependencies: DEV_DEPS,
    });
  });

  it("src/math.ts has add + clamp RED stubs", () => {
    const src = read(scaffold("ralph"), "src/math.ts");
    expect(src).toContain("/** RED stubs — implement items from fix_plan.md. */");
    expect(src).toContain("export function add(_a: number, _b: number): number {");
    expect(src).toContain('throw new Error("add not implemented");');
    expect(src).toContain("export function clamp(_n: number, _min: number, _max: number): number {");
    expect(src).toContain('throw new Error("clamp not implemented");');
  });

  it("test/math.test.ts pins add + clamp assertions", () => {
    const t = read(scaffold("ralph"), "test/math.test.ts");
    expect(t).toContain('import { add, clamp } from "../src/math.ts";');
    expect(t).toContain('test("add", () => assert.equal(add(2, 3), 5));');
    expect(t).toContain('test("clamp", () => assert.equal(clamp(10, 0, 5), 5));');
  });

  it("fix_plan.md lists the two checklist items", () => {
    const f = read(scaffold("ralph"), "fix_plan.md");
    expect(f).toContain("# Fix plan");
    expect(f).toContain("- [ ] Export `add(a, b)` that returns the sum");
    expect(f).toContain("- [ ] Export `clamp(n, min, max)` that clamps n into [min, max]");
  });

  it("AGENTS.md has the agent notes", () => {
    const a = read(scaffold("ralph"), "AGENTS.md");
    expect(a).toContain("# Agent notes");
    expect(a).toContain("- Prefer pure functions in src/math.ts");
    expect(a).toContain("- Keep tests green after each plan item");
  });

  it("README.md points at fix_plan.md", () => {
    const r = read(scaffold("ralph"), "README.md");
    expect(r).toContain("# ralph target (RED)");
    expect(r).toContain("Work the checklist in fix_plan.md.");
  });
});

// ---------------------------------------------------------------------------
// experiment-ab template
// ---------------------------------------------------------------------------

describe("experiment-ab template files", () => {
  it("package.json is exact (test .mjs + sim script, no devDeps/typecheck)", () => {
    const dest = scaffold("experiment-ab");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-experiment-ab",
      private: true,
      type: "module",
      scripts: {
        test: "node --test test/**/*.test.mjs",
        sim: "node sim.mjs",
      },
    });
  });

  it("sim.mjs prints the exact RED conversion metrics", () => {
    const dest = scaffold("experiment-ab");
    const sim = read(dest, "sim.mjs");
    expect(sim).toContain("control: { conversion: 0.18 },");
    expect(sim).toContain("variantB: { conversion: 0.15 },");
    expect(sim).toContain("process.stdout.write(JSON.stringify(metrics));");
    // Execute it and assert the exact JSON emitted on stdout.
    const out = execSync("node sim.mjs", { cwd: dest, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({
      control: { conversion: 0.18 },
      variantB: { conversion: 0.15 },
    });
    expect(out).toContain('"conversion":0.18');
    expect(out).toContain('"conversion":0.15');
  });

  it("test/smoke.test.mjs checks sim.mjs mentions conversion", () => {
    const t = read(scaffold("experiment-ab"), "test/smoke.test.mjs");
    expect(t).toContain('test("sim script exists", () => {');
    expect(t).toContain(
      'assert.ok(readFileSync(new URL("../sim.mjs", import.meta.url), "utf8").includes("conversion"));',
    );
  });

  it("README.md mentions npm run sim", () => {
    const r = read(scaffold("experiment-ab"), "README.md");
    expect(r).toContain("# experiment-ab target (RED)");
    expect(r).toContain("`npm run sim` prints low conversion.");
  });
});

// ---------------------------------------------------------------------------
// evaluator-optimizer template
// ---------------------------------------------------------------------------

describe("evaluator-optimizer template files", () => {
  it("package.json is exact (bench script)", () => {
    const dest = scaffold("evaluator-optimizer");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-evaluator-optimizer",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test test/**/*.test.ts",
        typecheck: "tsc --noEmit",
        bench: "node bench.mjs",
      },
      devDependencies: DEV_DEPS,
    });
  });

  it("src/fetchWithRetry.ts is the no-retry RED stub", () => {
    const src = read(scaffold("evaluator-optimizer"), "src/fetchWithRetry.ts");
    expect(src).toContain(
      "export type RetryOpts = { retries?: number; fetchImpl?: typeof fetch };",
    );
    expect(src).toContain("/** RED stub — no retries. */");
    expect(src).toContain(
      "export async function fetchWithRetry(url: string, opts: RetryOpts = {}): Promise<Response> {",
    );
    expect(src).toContain("const f = opts.fetchImpl ?? fetch;");
    expect(src).toContain("return f(url);");
  });

  it("test/fetchWithRetry.test.ts pins the retry expectations", () => {
    const t = read(scaffold("evaluator-optimizer"), "test/fetchWithRetry.test.ts");
    expect(t).toContain('import { fetchWithRetry } from "../src/fetchWithRetry.ts";');
    expect(t).toContain('test("succeeds after transient 5xx", async () => {');
    expect(t).toContain('if (n < 3) return new Response("nope", { status: 503 });');
    expect(t).toContain('return new Response("ok", { status: 200 });');
    expect(t).toContain(
      'const res = await fetchWithRetry("https://example.test", { fetchImpl, retries: 3 });',
    );
    expect(t).toContain("assert.equal(res.status, 200);");
    expect(t).toContain("assert.equal(n, 3);");
  });

  it("bench.mjs prints the exact RED p95 metric", () => {
    const dest = scaffold("evaluator-optimizer");
    const bench = read(dest, "bench.mjs");
    expect(bench).toContain("// RED: p95 above the 150ms bar. Print ONLY JSON.");
    expect(bench).toContain("process.stdout.write(JSON.stringify({ p95_ms: 500 }));");
    const out = execSync("node bench.mjs", { cwd: dest, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ p95_ms: 500 });
    expect(out).toContain('"p95_ms":500');
  });

  it("README.md names the evaluator-optimizer example", () => {
    const r = read(scaffold("evaluator-optimizer"), "README.md");
    expect(r).toContain("# evaluator-optimizer target (RED)");
    expect(r).toContain("npm run loopgen -- run examples/patterns/evaluator-optimizer.loop.yaml");
  });
});

// ---------------------------------------------------------------------------
// osmani template
// ---------------------------------------------------------------------------

describe("osmani template files", () => {
  it("package.json is exact (coverage script)", () => {
    const dest = scaffold("osmani");
    expect(readJson(dest, "package.json")).toEqual({
      name: "loopgen-target-osmani",
      private: true,
      type: "module",
      scripts: {
        test: "node --import tsx --test test/**/*.test.ts",
        typecheck: "tsc --noEmit",
        coverage: "node coverage.mjs",
      },
      devDependencies: DEV_DEPS,
    });
  });

  it("src/math.ts has add/subtract implemented and multiply as a TODO stub", () => {
    const src = read(scaffold("osmani"), "src/math.ts");
    expect(src).toContain("export function add(a: number, b: number): number {");
    expect(src).toContain("return a + b;");
    expect(src).toContain("export function subtract(a: number, b: number): number {");
    expect(src).toContain("return a - b;");
    expect(src).toContain(
      "/** TODO/FIXME: implement multiply — discover stage should find this. */",
    );
    expect(src).toContain("export function multiply(_a: number, _b: number): number {");
    expect(src).toContain('throw new Error("multiply not implemented");');
  });

  it("test/math.test.ts pins add/subtract/multiply assertions", () => {
    const t = read(scaffold("osmani"), "test/math.test.ts");
    expect(t).toContain('import { add, subtract, multiply } from "../src/math.ts";');
    expect(t).toContain('test("add", () => assert.equal(add(1, 2), 3));');
    expect(t).toContain('test("subtract", () => assert.equal(subtract(5, 2), 3));');
    expect(t).toContain('test("multiply", () => assert.equal(multiply(3, 4), 12));');
  });

  it("coverage.mjs prints the exact RED lines metric (67)", () => {
    const dest = scaffold("osmani");
    const cov = read(dest, "coverage.mjs");
    expect(cov).toContain("process.stdout.write(JSON.stringify({ lines: 67 }));");
    const out = execSync("node coverage.mjs", { cwd: dest, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ lines: 67 });
    expect(out).toContain('"lines":67');
  });

  it("README.md describes the missing multiply + coverage 67", () => {
    const r = read(scaffold("osmani"), "README.md");
    expect(r).toContain("# osmani harness target (RED)");
    expect(r).toContain("`multiply` is missing (TODO/FIXME)");
    expect(r).toContain("`npm run coverage` reports lines: 67 (&lt; 85)");
  });
});

// ---------------------------------------------------------------------------
// initTarget control flow
// ---------------------------------------------------------------------------

describe("initTarget control flow", () => {
  it("throws for an unknown template listing every available id", () => {
    let err: Error | undefined;
    try {
      initTarget("does-not-exist");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = err!.message;
    expect(msg).toContain('unknown target template "does-not-exist"');
    // The joined list of known ids must be present (kills the .join(", ") mutant).
    expect(msg).toContain(
      "Available: fizzbuzz, fetch-user, api-orders, ralph, experiment-ab, evaluator-optimizer, osmani",
    );
  });

  it("default dest is ./target when opts.dest is omitted", () => {
    // Stryker (and some vitest worker pools) forbid process.chdir(); mock cwd instead.
    const base = tmp();
    const realBase = realpathSync(base);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realBase);
    try {
      const result = initTarget("fizzbuzz", { git: false });
      // path.resolve(opts.dest ?? "./target") must land on <cwd>/target.
      expect(result.dest).toBe(path.resolve(realBase, "target"));
      expect(existsSync(path.join(realBase, "target", "src/fizzbuzz.ts"))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("result.files is sorted and uses forward slashes", () => {
    const dest = path.join(tmp(), "t");
    const result = initTarget("fizzbuzz", { dest, git: false });
    expect(result.files).toEqual([
      "README.md",
      "package.json",
      "src/fizzbuzz.ts",
      "src/fizzbuzz.test.ts",
      "tsconfig.json",
    ].sort());
    // Every written path uses forward slashes.
    for (const f of result.files) expect(f).not.toContain("\\");
    // And the sort is stable/ascending.
    expect([...result.files].sort()).toEqual(result.files);
  });

  it("returns the resolved template id even when given an example alias", () => {
    const dest = path.join(tmp(), "t");
    const result = initTarget("examples/building-blocks/api-feature-grok.loop.yaml", {
      dest,
      git: false,
    });
    expect(result.template).toBe("api-orders");
    expect(result.dest).toBe(path.resolve(dest));
  });

  it("refuses a non-empty dest without force, and the message names the dest", () => {
    const dest = path.join(tmp(), "full");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "keep.txt"), "x");
    let err: Error | undefined;
    try {
      initTarget("fizzbuzz", { dest });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("not empty");
    expect(err!.message).toContain(path.resolve(dest));
    // Nothing was scaffolded.
    expect(existsSync(path.join(dest, "package.json"))).toBe(false);
  });

  it("force:true overwrites a non-empty dest", () => {
    const dest = path.join(tmp(), "full");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "keep.txt"), "x");
    const result = initTarget("fizzbuzz", { dest, force: true, git: false });
    expect(result.files.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
  });

  it("treats a dest containing only .git as empty (no force needed)", () => {
    const dest = path.join(tmp(), "onlygit");
    mkdirSync(path.join(dest, ".git"), { recursive: true });
    writeFileSync(path.join(dest, ".git", "marker"), "x");
    // .git is filtered out → entries empty → scaffolds without force.
    const result = initTarget("fizzbuzz", { dest, git: false });
    expect(result.files.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
  });

  it("scaffolds into a brand-new (non-existent) dest without complaint", () => {
    const dest = path.join(tmp(), "brand", "new", "nested");
    const result = initTarget("fizzbuzz", { dest, git: false });
    expect(existsSync(path.join(dest, "src/fizzbuzz.ts"))).toBe(true);
    expect(result.git).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// git handling
// ---------------------------------------------------------------------------

describe("initTarget git handling", () => {
  it("git default (true): creates a repo and reports git===true", () => {
    const dest = path.join(tmp(), "gitdefault");
    const result = initTarget("fizzbuzz", { dest });
    expect(result.git).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
    const inside = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dest,
      encoding: "utf8",
    }).trim();
    expect(inside).toBe("true");
  });

  it("git:false: no repo created and git===false", () => {
    const dest = path.join(tmp(), "nogit");
    const result = initTarget("fizzbuzz", { dest, git: false });
    expect(result.git).toBe(false);
    expect(existsSync(path.join(dest, ".git"))).toBe(false);
  });

  it("already-a-git-repo branch: inside==='true' path reports git===true without re-init", () => {
    const dest = path.join(tmp(), "existing");
    // First scaffold without git, then make it a repo ourselves.
    initTarget("fizzbuzz", { dest, git: false });
    execSync("git init", { cwd: dest, stdio: "ignore" });
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
    // Re-run with force + git: the "inside === 'true'" branch must be taken.
    const result = initTarget("fizzbuzz", { dest, force: true, git: true });
    expect(result.git).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(true);
  });
});
