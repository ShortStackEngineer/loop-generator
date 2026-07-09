import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Materialize a minimal RED workspace for the illustrative `./target` examples.
 * Specs in building-blocks/ and patterns/ expect the user to point at a real
 * repo; these templates give a cold start that fails for the right reason so
 * `loopgen run` can demonstrate the feedback loop without hand-building npm/ts.
 */

export interface TargetTemplateMeta {
  id: string;
  /** Short description for `loopgen init-target --list`. */
  description: string;
  /** Example specs this scaffold is meant for. */
  examples: string[];
}

export interface InitTargetResult {
  template: string;
  dest: string;
  files: string[];
  git: boolean;
}

type FileMap = Record<string, string>;

const TEMPLATES: Record<
  string,
  {
    meta: TargetTemplateMeta;
    files: () => FileMap;
  }
> = {
  fizzbuzz: {
    meta: {
      id: "fizzbuzz",
      description: "TypeScript fizzbuzz stub + failing tests (function-fizzbuzz)",
      examples: ["examples/building-blocks/function-fizzbuzz.loop.yaml"],
    },
    files: fizzbuzzFiles,
  },
  "fetch-user": {
    meta: {
      id: "fetch-user",
      description: "TypeScript fetchUser without backoff + RED retry tests (copilot/opencode)",
      examples: [
        "examples/building-blocks/copilot-feature.loop.yaml",
        "examples/building-blocks/opencode-feature.loop.yaml",
      ],
    },
    files: fetchUserFiles,
  },
  "api-orders": {
    meta: {
      id: "api-orders",
      description: "Minimal Express app without GET /orders (api-feature-grok)",
      examples: ["examples/building-blocks/api-feature-grok.loop.yaml"],
    },
    files: apiOrdersFiles,
  },
  ralph: {
    meta: {
      id: "ralph",
      description: "Tiny math stubs + fix_plan.md checklist (ralph-loop)",
      examples: ["examples/patterns/ralph-loop.loop.yaml"],
    },
    files: ralphFiles,
  },
  "experiment-ab": {
    meta: {
      id: "experiment-ab",
      description: "Offline A/B sim with RED conversion metric (experiment-ab)",
      examples: ["examples/building-blocks/experiment-ab.loop.yaml"],
    },
    files: experimentAbFiles,
  },
  "evaluator-optimizer": {
    meta: {
      id: "evaluator-optimizer",
      description: "fetchWithRetry stub + high p95 bench (evaluator-optimizer)",
      examples: ["examples/patterns/evaluator-optimizer.loop.yaml"],
    },
    files: evaluatorOptimizerFiles,
  },
  osmani: {
    meta: {
      id: "osmani",
      description: "Math lib with TODO multiply + coverage gate (osmani-harness)",
      examples: ["examples/patterns/osmani-harness.batch.yaml"],
    },
    files: osmaniFiles,
  },
};

/** Example path / basename → template id. */
const EXAMPLE_ALIASES: Record<string, string> = {
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

export function listTargetTemplates(): TargetTemplateMeta[] {
  return Object.values(TEMPLATES).map((t) => t.meta);
}

/** Resolve a template id or example path/basename to a known template id. */
export function resolveTargetTemplate(nameOrExample: string): string | null {
  const raw = nameOrExample.trim();
  if (!raw) return null;
  if (TEMPLATES[raw]) return raw;
  const base = path.basename(raw);
  if (TEMPLATES[base]) return base;
  if (EXAMPLE_ALIASES[base]) return EXAMPLE_ALIASES[base];
  if (EXAMPLE_ALIASES[raw]) return EXAMPLE_ALIASES[raw];
  // Strip directory prefixes like examples/building-blocks/function-fizzbuzz.loop.yaml
  const stripped = base.replace(/\.loop\.yaml$|\.batch\.yaml$/, "");
  if (TEMPLATES[stripped]) return stripped;
  if (EXAMPLE_ALIASES[stripped]) return EXAMPLE_ALIASES[stripped];
  return null;
}

export interface InitTargetOptions {
  /** Destination directory (created if missing). Default: ./target */
  dest?: string;
  /** Run `git init` when the dest is not already a git repo (default true). */
  git?: boolean;
  /** Overwrite existing files (default false — refuse if dest has content). */
  force?: boolean;
}

/**
 * Write a RED scaffold into `dest`. Returns the list of relative files written.
 */
export function initTarget(templateOrExample: string, opts: InitTargetOptions = {}): InitTargetResult {
  const id = resolveTargetTemplate(templateOrExample);
  if (!id || !TEMPLATES[id]) {
    const known = listTargetTemplates()
      .map((t) => t.id)
      .join(", ");
    throw new Error(`unknown target template "${templateOrExample}". Available: ${known}`);
  }
  const dest = path.resolve(opts.dest ?? "./target");
  const force = opts.force ?? false;
  const wantGit = opts.git !== false;

  if (existsSync(dest)) {
    // Refuse non-empty destinations unless --force (avoid clobbering a real repo).
    let entries: string[] = [];
    try {
      entries = readdirSync(dest).filter((e) => e !== ".git");
    } catch {
      entries = [];
    }
    if (entries.length > 0 && !force) {
      throw new Error(
        `destination ${dest} is not empty (pass force: true / --force to overwrite scaffold files)`,
      );
    }
  }

  const files = TEMPLATES[id]!.files();
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dest, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    written.push(rel.replace(/\\/g, "/"));
  }

  let git = false;
  if (wantGit) {
    try {
      const inside = execSync("git rev-parse --is-inside-work-tree", {
        cwd: dest,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (inside === "true") {
        git = true;
      }
    } catch {
      try {
        execSync("git init", { cwd: dest, stdio: "ignore" });
        git = true;
      } catch {
        git = false;
      }
    }
  }

  return { template: id, dest, files: written.sort(), git };
}

// ---------------------------------------------------------------------------
// Template file contents
// ---------------------------------------------------------------------------

function tsconfig(): string {
  return `${JSON.stringify(
    {
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
    },
    null,
    2,
  )}\n`;
}

function fizzbuzzFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-fizzbuzz",
        private: true,
        type: "module",
        scripts: {
          test: "node --import tsx --test src/fizzbuzz.test.ts",
          typecheck: "tsc --noEmit",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/fizzbuzz.ts": `/** RED stub — implement fizzbuzz(n) as described in the loop requirements. */
export function fizzbuzz(_n: number): string[] {
  throw new Error("fizzbuzz not implemented");
}
`,
    "src/fizzbuzz.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { fizzbuzz } from "./fizzbuzz.ts";

test("n=0 returns empty array", () => {
  assert.deepEqual(fizzbuzz(0), []);
});

test("maps 1..15 with Fizz/Buzz/FizzBuzz", () => {
  const out = fizzbuzz(15);
  assert.equal(out[2], "Fizz");
  assert.equal(out[4], "Buzz");
  assert.equal(out[14], "FizzBuzz");
  assert.equal(out[0], "1");
});
`,
    "README.md": `# fizzbuzz target (RED)

Scaffolded by \`loopgen init-target fizzbuzz\`. Run \`npm install\` then the loop:

\`\`\`bash
npm install
npm run loopgen -- run examples/building-blocks/function-fizzbuzz.loop.yaml -b .
\`\`\`

(with this directory as \`workspace.dir\` / \`./target\`).
`,
  };
}

function fetchUserFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-fetch-user",
        private: true,
        type: "module",
        scripts: {
          test: "node --import tsx --test test/**/*.test.ts",
          typecheck: "tsc --noEmit",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/fetchUser.ts": `export type FetchUserOpts = { fetchImpl?: typeof fetch };

/** RED stub — single-shot fetch with no retries. */
export async function fetchUser(url: string, opts: FetchUserOpts = {}): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}
`,
    "test/fetchUser.backoff.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUser } from "../src/fetchUser.ts";

test("succeeds after a transient 5xx", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 3) return new Response("nope", { status: 503 });
    return Response.json({ id: 1 });
  };
  // Stub has no retries — this fails until exponential backoff is implemented.
  await assert.rejects(() => fetchUser("https://example.test/u", { fetchImpl }));
});

test("does not retry 4xx", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response("nope", { status: 404 });
  };
  await assert.rejects(() => fetchUser("https://example.test/u", { fetchImpl }));
  assert.equal(n, 1);
});
`,
    "README.md": `# fetchUser target (RED)

Scaffolded by \`loopgen init-target fetch-user\`. For copilot/opencode feature examples.
`,
  };
}

function apiOrdersFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/app.ts": `import express from "express";

export function createApp() {
  const app = express();
  app.get("/health", (_req, res) => res.json({ ok: true }));
  // RED: GET /orders is missing — the loop agent should add it.
  return app;
}
`,
    "test/orders.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.ts";

test("GET /orders is implemented", async () => {
  const res = await request(createApp()).get("/orders");
  // Currently 404 — agent must implement pagination + 400 validation.
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
});
`,
    "README.md": `# api-orders target (RED)

Scaffolded by \`loopgen init-target api-orders\`. Express app without GET /orders.
`,
  };
}

function ralphFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-ralph",
        private: true,
        type: "module",
        scripts: {
          test: "node --import tsx --test test/**/*.test.ts",
          typecheck: "tsc --noEmit",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/math.ts": `/** RED stubs — implement items from fix_plan.md. */
export function add(_a: number, _b: number): number {
  throw new Error("add not implemented");
}
export function clamp(_n: number, _min: number, _max: number): number {
  throw new Error("clamp not implemented");
}
`,
    "test/math.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, clamp } from "../src/math.ts";

test("add", () => assert.equal(add(2, 3), 5));
test("clamp", () => assert.equal(clamp(10, 0, 5), 5));
`,
    "fix_plan.md": `# Fix plan

- [ ] Export \`add(a, b)\` that returns the sum
- [ ] Export \`clamp(n, min, max)\` that clamps n into [min, max]
`,
    "AGENTS.md": `# Agent notes

- Prefer pure functions in src/math.ts
- Keep tests green after each plan item
`,
    "README.md": `# ralph target (RED)

Scaffolded by \`loopgen init-target ralph\`. Work the checklist in fix_plan.md.
`,
  };
}

function experimentAbFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-experiment-ab",
        private: true,
        type: "module",
        scripts: {
          test: "node --test test/**/*.test.mjs",
          sim: "node sim.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "sim.mjs": `// RED: variantB conversion is below the +2pp bar over control baseline 0.18.
// Print ONLY JSON on stdout (experiment evaluator parses the whole stream).
const metrics = {
  control: { conversion: 0.18 },
  variantB: { conversion: 0.15 },
};
process.stdout.write(JSON.stringify(metrics));
`,
    "test/smoke.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("sim script exists", () => {
  assert.ok(readFileSync(new URL("../sim.mjs", import.meta.url), "utf8").includes("conversion"));
});
`,
    "README.md": `# experiment-ab target (RED)

Scaffolded by \`loopgen init-target experiment-ab\`. \`npm run sim\` prints low conversion.
`,
  };
}

function evaluatorOptimizerFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-evaluator-optimizer",
        private: true,
        type: "module",
        scripts: {
          test: "node --import tsx --test test/**/*.test.ts",
          typecheck: "tsc --noEmit",
          bench: "node bench.mjs",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/fetchWithRetry.ts": `export type RetryOpts = { retries?: number; fetchImpl?: typeof fetch };

/** RED stub — no retries. */
export async function fetchWithRetry(url: string, opts: RetryOpts = {}): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  return f(url);
}
`,
    "test/fetchWithRetry.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/fetchWithRetry.ts";

test("succeeds after transient 5xx", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 3) return new Response("nope", { status: 503 });
    return new Response("ok", { status: 200 });
  };
  await assert.rejects(() => fetchWithRetry("https://example.test", { fetchImpl, retries: 3 }));
});
`,
    "bench.mjs": `// RED: p95 above the 150ms bar. Print ONLY JSON.
process.stdout.write(JSON.stringify({ p95_ms: 500 }));
`,
    "README.md": `# evaluator-optimizer target (RED)

Scaffolded by \`loopgen init-target evaluator-optimizer\`.
`,
  };
}

function osmaniFiles(): FileMap {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "loopgen-target-osmani",
        private: true,
        type: "module",
        scripts: {
          test: "node --import tsx --test test/**/*.test.ts",
          typecheck: "tsc --noEmit",
          coverage: "node coverage.mjs",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2", "@types/node": "^22.10.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": tsconfig(),
    "src/math.ts": `export function add(a: number, b: number): number {
  return a + b;
}
export function subtract(a: number, b: number): number {
  return a - b;
}
/** TODO/FIXME: implement multiply — discover stage should find this. */
export function multiply(_a: number, _b: number): number {
  throw new Error("multiply not implemented");
}
`,
    "test/math.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract, multiply } from "../src/math.ts";

test("add", () => assert.equal(add(1, 2), 3));
test("subtract", () => assert.equal(subtract(5, 2), 3));
test("multiply", () => assert.equal(multiply(3, 4), 12));
`,
    "coverage.mjs": `// Baseline below the verify stage's 85 line bar. Agent should raise this.
process.stdout.write(JSON.stringify({ lines: 67 }));
`,
    "README.md": `# osmani harness target (RED)

Scaffolded by \`loopgen init-target osmani\`.

- \`multiply\` is missing (TODO/FIXME)
- \`npm run coverage\` reports lines: 67 (&lt; 85)
`,
  };
}
