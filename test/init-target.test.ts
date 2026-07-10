import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  initTarget,
  listTargetTemplates,
  resolveTargetTemplate,
} from "../src/scaffold/init-target";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "loopgen-init-"));
  dirs.push(d);
  return d;
}

describe("resolveTargetTemplate", () => {
  it("resolves ids, basenames, and example paths", () => {
    expect(resolveTargetTemplate("fizzbuzz")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("function-fizzbuzz.loop.yaml")).toBe("fizzbuzz");
    expect(resolveTargetTemplate("examples/building-blocks/copilot-feature.loop.yaml")).toBe(
      "fetch-user",
    );
    expect(resolveTargetTemplate("osmani-harness.batch.yaml")).toBe("osmani");
    expect(resolveTargetTemplate("nope")).toBeNull();
  });
});

describe("listTargetTemplates", () => {
  it("exposes every built-in template with example pointers", () => {
    const list = listTargetTemplates();
    expect(list.map((t) => t.id).sort()).toEqual(
      [
        "api-orders",
        "evaluator-optimizer",
        "experiment-ab",
        "fetch-user",
        "fizzbuzz",
        "osmani",
        "ralph",
      ].sort(),
    );
    expect(list.every((t) => t.examples.length > 0)).toBe(true);
  });
});

describe("initTarget", () => {
  it("writes a fizzbuzz RED scaffold and git-inits by default", () => {
    const dest = path.join(tmp(), "target");
    const result = initTarget("fizzbuzz", { dest });
    expect(result.template).toBe("fizzbuzz");
    expect(result.git).toBe(true);
    expect(result.files).toContain("src/fizzbuzz.ts");
    expect(existsSync(path.join(dest, "src/fizzbuzz.ts"))).toBe(true);
    expect(readFileSync(path.join(dest, "src/fizzbuzz.ts"), "utf8")).toMatch(/not implemented/);
    const inside = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dest,
      encoding: "utf8",
    }).trim();
    expect(inside).toBe("true");
  });

  it("accepts an example path as the template argument", () => {
    const dest = path.join(tmp(), "t");
    const result = initTarget("examples/patterns/ralph-loop.loop.yaml", { dest, git: false });
    expect(result.template).toBe("ralph");
    expect(result.files).toContain("fix_plan.md");
    expect(result.git).toBe(false);
  });

  it("refuses a non-empty destination without force", () => {
    const dest = path.join(tmp(), "full");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "keep.txt"), "x");
    expect(() => initTarget("fizzbuzz", { dest })).toThrow(/not empty/);
    const result = initTarget("fizzbuzz", { dest, force: true });
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("honors git: false (no .git)", () => {
    const dest = path.join(tmp(), "nogit");
    const result = initTarget("fizzbuzz", { dest, git: false });
    expect(result.git).toBe(false);
    expect(existsSync(path.join(dest, ".git"))).toBe(false);
  });
});

/** Resolve tsx loader from the monorepo so scaffold tests run outside their own node_modules. */
const TSX_LOADER = path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");

function runScaffoldTest(dest: string, testFile: string): void {
  execSync(`node --import ${JSON.stringify(TSX_LOADER)} --test ${JSON.stringify(testFile)}`, {
    cwd: dest,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Template polarity: scaffolds must start RED for the right reason and go GREEN
 * only with a correct implementation — not born green, not unsatisfiable.
 */
describe("template polarity (fetch-user + evaluator-optimizer)", () => {
  it("fetch-user: stub fails the success-after-5xx test; correct backoff passes", () => {
    const dest = path.join(tmp(), "fu");
    initTarget("fetch-user", { dest, git: false });
    // Stub: single-shot → throws on first 503 → test wants success → RED
    expect(() => runScaffoldTest(dest, "test/fetchUser.backoff.test.ts")).toThrow();

    // Correct-ish backoff: retry 5xx until 200
    writeFileSync(
      path.join(dest, "src/fetchUser.ts"),
      `export type FetchUserOpts = { fetchImpl?: typeof fetch };
export async function fetchUser(url: string, opts: FetchUserOpts = {}): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  let last: Response | undefined;
  for (let i = 0; i < 3; i++) {
    last = await f(url);
    if (last.ok) return last.json();
    if (last.status < 500) throw new Error(\`HTTP \${last.status}\`);
  }
  throw new Error(\`HTTP \${last?.status}\`);
}
`,
    );
    runScaffoldTest(dest, "test/fetchUser.backoff.test.ts");
  });

  it("evaluator-optimizer: stub fails success-after-5xx; correct retry passes", () => {
    const dest = path.join(tmp(), "eo");
    initTarget("evaluator-optimizer", { dest, git: false });
    expect(() => runScaffoldTest(dest, "test/fetchWithRetry.test.ts")).toThrow();

    writeFileSync(
      path.join(dest, "src/fetchWithRetry.ts"),
      `export type RetryOpts = { retries?: number; fetchImpl?: typeof fetch };
export async function fetchWithRetry(url: string, opts: RetryOpts = {}): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  let last: Response | undefined;
  for (let i = 0; i < retries; i++) {
    last = await f(url);
    if (last.ok || last.status < 500) return last;
  }
  return last!;
}
`,
    );
    runScaffoldTest(dest, "test/fetchWithRetry.test.ts");
  });
});
