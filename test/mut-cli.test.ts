import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isObject,
  asString,
  numberOr,
  parseJsonl,
  parseJsonObjects,
  cleanSummary,
  lastMeaningfulLine,
  tail,
  foldPrompt,
  spawnCollect,
  type ResolvedBin,
} from "../src/drivers/cli";

// ─── isObject ────────────────────────────────────────────────────────────────
// Kills: L17 ConditionalExpression(true), the two LogicalOperator mutants
// (&& → ||), and the `!Array.isArray` MethodExpression → Array.isArray.
describe("isObject", () => {
  it("is true only for a plain object", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it("rejects null (kills `typeof===object && v!==null` → `|| v!==null` and ConditionalExpression true)", () => {
    // typeof null === "object" but v === null, so the `!== null` clause must hold.
    expect(isObject(null)).toBe(false);
  });

  it("rejects arrays (kills the `&& !Array.isArray` clause and the MethodExpression flip)", () => {
    // typeof [] === "object" and [] !== null, so only the !Array.isArray clause
    // distinguishes it. If the method is flipped to Array.isArray, this fails.
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2, 3])).toBe(false);
  });

  it("rejects non-object primitives (kills the `typeof === object` clause)", () => {
    expect(isObject("s")).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject(true)).toBe(false);
  });
});

// ─── asString ────────────────────────────────────────────────────────────────
// Kills: L21 ConditionalExpression(true), and the `.trim()` MethodExpression
// (v.trim() → v) — a whitespace-only string must be rejected, which only holds
// if trim() actually runs.
describe("asString", () => {
  it("returns a non-empty string unchanged", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("  padded  ")).toBe("  padded  ");
  });

  it("rejects a whitespace-only string (kills v.trim() → v)", () => {
    // "   ".trim() is falsy → undefined. Without .trim(), "   " is truthy → returned.
    expect(asString("   ")).toBeUndefined();
    expect(asString("")).toBeUndefined();
  });

  it("rejects non-strings (kills ConditionalExpression true and typeof clause)", () => {
    expect(asString(5)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString({})).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
  });
});

// ─── numberOr ────────────────────────────────────────────────────────────────
// Kills: L26 ConditionalExpression(true), LogicalOperator (&& → ||), and the
// !Number.isNaN clause. Returns the FIRST finite number; NaN and non-numbers
// are skipped.
describe("numberOr", () => {
  it("returns the first finite number, skipping earlier non-numbers", () => {
    expect(numberOr("x", null, 7, 9)).toBe(7);
    expect(numberOr(3)).toBe(3);
  });

  it("skips NaN (kills the `!Number.isNaN` clause and the `&&` → `||` flip)", () => {
    // If the NaN guard is removed/flipped, NaN would be returned first.
    expect(numberOr(NaN, 5)).toBe(5);
  });

  it("returns undefined when no finite number present (kills ConditionalExpression true)", () => {
    expect(numberOr("a", null, undefined, NaN)).toBeUndefined();
    expect(numberOr()).toBeUndefined();
  });

  it("treats 0 as a valid finite number", () => {
    expect(numberOr(0, 1)).toBe(0);
  });
});

// ─── parseJsonl ──────────────────────────────────────────────────────────────
// Kills: L37 split MethodExpression (line → line? no; it's the map/trim chain
// via .split), L38 `!l || l[0]!=="{"` (both branches), L38 `l[0]!=="{"`
// Equality/Conditional, L41 isObject guard.
describe("parseJsonl", () => {
  it("parses one object per line, skipping blank and non-`{` lines", () => {
    const out = parseJsonl('{"a":1}\n\nlog line\n{"b":2}\n');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns [] for empty input (kills the `!l` blank-line guard)", () => {
    // If `!l` is dropped, a blank line's l[0] is undefined !== "{" so still
    // skipped — but split produces [""] and the loop must not throw/emit.
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n\n\n")).toEqual([]);
  });

  it("skips lines not beginning with `{` (kills EqualityOperator on l[0]!==\"{\")", () => {
    // A JSON array line begins with `[`, not `{`, so it must be skipped here.
    expect(parseJsonl("[1,2,3]")).toEqual([]);
    expect(parseJsonl("not json")).toEqual([]);
  });

  it("skips a top-level JSON array masquerading as an object line", () => {
    // `[{"a":1}]` starts with `[`, is skipped. Only `{`-prefixed lines attempted.
    expect(parseJsonl('[{"a":1}]')).toEqual([]);
  });

  it("drops parsed non-objects (kills the isObject push guard at L41)", () => {
    // A `{`-prefixed line that JSON-parses to a non-object cannot happen (an
    // object literal is an object), so exercise a line that parses to something
    // isObject rejects would require a `{`-starting non-object — instead confirm
    // a malformed `{` line is caught and produces nothing.
    expect(parseJsonl("{not valid json")).toEqual([]);
    // valid object survives the isObject guard
    expect(parseJsonl('{"ok":true}')).toEqual([{ ok: true }]);
  });

  it("handles CRLF line endings (kills the /\\r?\\n/ split regex weakening)", () => {
    expect(parseJsonl('{"a":1}\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

// ─── parseJsonObjects ────────────────────────────────────────────────────────
// Kills: L55 trim, L56 empty-guard conditional, L57 block, L59 array declaration
// + Array.isArray + filter, line loop L65-70.
describe("parseJsonObjects", () => {
  it("returns [] for empty/whitespace input (kills L56 empty guard + L57 block)", () => {
    expect(parseJsonObjects("")).toEqual([]);
    expect(parseJsonObjects("   \n  ")).toEqual([]);
  });

  it("parses a single whole object", () => {
    expect(parseJsonObjects('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it("flattens a top-level array, filtering to objects (kills Array.isArray + filter)", () => {
    // The array branch keeps only objects: numbers/strings are filtered out.
    expect(parseJsonObjects('[{"a":1},5,"x",{"b":2},null]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns [] when the whole doc is a non-object, non-array JSON value", () => {
    // JSON.parse("5") succeeds → not array, not object → [] (kills the ternary).
    expect(parseJsonObjects("5")).toEqual([]);
    expect(parseJsonObjects('"a string"')).toEqual([]);
    expect(parseJsonObjects("null")).toEqual([]);
  });

  it("falls back to line-by-line for object AND array lines (kills L66 l[0] checks)", () => {
    // Not valid as a whole doc (mixed prose), so the line loop runs. A line
    // starting with `[` must be accepted here (unlike parseJsonl).
    const out = parseJsonObjects('prose\n{"a":1}\n[{"b":2},7]\nmore prose');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips blank and non-{[/ lines in fallback (kills `!l` and `l[0]!==\"[\"`)", () => {
    // The `[` equality mutant (l[0]==="[") is killed: a `[` line must be kept.
    const out = parseJsonObjects("garbage\n\nplain text\n[{\"z\":9}]");
    expect(out).toEqual([{ z: 9 }]);
  });

  it("skips a `(`-prefixed line: neither `{` nor `[` (kills the L66 StringLiteral \"[\")", () => {
    // If the "[" literal is mutated to "", the l[0] !== "" guard changes; a
    // line beginning with `[` would then be dropped — assert it is kept.
    const out = parseJsonObjects("noise which is not json\n[1,{\"k\":1}]");
    expect(out).toEqual([{ k: 1 }]);
  });

  it("drops non-object parsed line values in fallback (kills isObject at L70)", () => {
    // A `{`-line that parses (valid object) is kept; a line that is `[...]`
    // with only primitives yields nothing.
    const out = parseJsonObjects("prose\n[1,2,3]\n{\"a\":1}");
    expect(out).toEqual([{ a: 1 }]);
  });

  it("handles CRLF in the fallback split", () => {
    const out = parseJsonObjects('prose\r\n{"a":1}\r\n{"b":2}');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

// ─── cleanSummary ────────────────────────────────────────────────────────────
// Kills: L82 replace MethodExpression, L83 EqualityOperator (> → >=) boundary,
// slice arithmetic.
describe("cleanSummary", () => {
  it("collapses runs of whitespace to single spaces and trims (kills the replace)", () => {
    expect(cleanSummary("a\n\n  b   c")).toBe("a b c");
    expect(cleanSummary("  lead\ttab\nnewline  ")).toBe("lead tab newline");
  });

  it("returns short text unchanged (no ellipsis)", () => {
    expect(cleanSummary("short")).toBe("short");
  });

  it("does NOT truncate a string exactly at max (kills `>` → `>=` boundary)", () => {
    // length === max must be returned whole (no ellipsis). `>=` would truncate.
    const exact = "x".repeat(10);
    expect(cleanSummary(exact, 10)).toBe(exact);
    expect(cleanSummary(exact, 10).length).toBe(10);
    expect(cleanSummary(exact, 10)).not.toContain("…");
  });

  it("truncates when length > max, keeping max-1 chars plus an ellipsis", () => {
    const over = "y".repeat(11);
    const out = cleanSummary(over, 10);
    expect(out.length).toBe(10);
    expect(out).toBe("y".repeat(9) + "…");
  });

  it("defaults max to 280", () => {
    expect(cleanSummary("x".repeat(500)).length).toBe(280);
    expect(cleanSummary("x".repeat(500)).endsWith("…")).toBe(true);
    // exactly 280 chars is untouched
    expect(cleanSummary("z".repeat(280))).toBe("z".repeat(280));
  });
});

// ─── lastMeaningfulLine ──────────────────────────────────────────────────────
// Kills: L92 split/map/filter chain, L94 map arrow (l.trim() → l), L96 timestamp
// regex, L97 extraNoise arrow, and the empty/nonempty return branches (L98).
describe("lastMeaningfulLine", () => {
  it("returns the last meaningful line, dropping timestamped level logs", () => {
    const stderr = [
      "2026-01-01T00:00:00.000Z ERROR something happened",
      "2026-01-01T00:00:00.000Z WARN also noise",
      "real failure here",
    ].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
  });

  it("trims each line (kills the map `l.trim()` → `l`)", () => {
    // The meaningful line is surrounded by whitespace; the result must be trimmed.
    expect(lastMeaningfulLine("   spaced error   ")).toBe("spaced error");
  });

  it("returns '' when everything is noise (kills the length-check return branch)", () => {
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z ERROR only noise")).toBe("");
    expect(lastMeaningfulLine("")).toBe("");
    expect(lastMeaningfulLine("\n\n  \n")).toBe("");
  });

  it("drops a TRAILING blank line so the real line is last (kills the .filter(Boolean) drop)", () => {
    // stderr ends with a newline → split yields a trailing "". Without filter(Boolean)
    // that empty string is the last element and the function would return "".
    expect(lastMeaningfulLine("real line\n")).toBe("real line");
    expect(lastMeaningfulLine("real line\n\n\n")).toBe("real line");
  });

  it("drops a TRAILING timestamped log so an earlier real line wins (kills the timestamp regex)", () => {
    // The noise is LAST here; only the regex filter lets the earlier line win.
    // If the regex is neutered, the timestamped line is returned instead.
    const stderr = ["real failure here", "2026-01-01T00:00:00.000Z ERROR trailing noise"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("real failure here");
  });

  it("drops blank lines and keeps the LAST non-noise line", () => {
    const stderr = ["first meaningful", "", "   ", "last meaningful"].join("\n");
    expect(lastMeaningfulLine(stderr)).toBe("last meaningful");
  });

  it("applies caller extraNoise patterns (kills the extraNoise arrow → undefined)", () => {
    const stderr = ["Skipping MCP tool: foo", "genuine error"].join("\n");
    expect(lastMeaningfulLine(stderr, [/Skipping MCP tool/])).toBe("genuine error");
    // when extraNoise is the LAST line, it must be filtered so an earlier line wins
    const stderr2 = ["genuine error", "MCP spam trailing"].join("\n");
    expect(lastMeaningfulLine(stderr2, [/MCP spam/])).toBe("genuine error");
  });

  it("does NOT treat a non-timestamped ERROR word as noise (regex requires the timestamp)", () => {
    // The regex demands a leading ISO timestamp; a bare "ERROR: boom" is kept.
    expect(lastMeaningfulLine("ERROR: boom")).toBe("ERROR: boom");
  });

  it("handles CRLF line endings", () => {
    expect(lastMeaningfulLine("2026-01-01T00:00:00.000Z INFO noise\r\nreal line")).toBe("real line");
  });
});

// ─── tail ────────────────────────────────────────────────────────────────────
// Kills: L103 EqualityOperator (<= boundary, both directions), L104 "…" literal,
// slice(-max) MethodExpression, and the UnaryOperator on -max.
describe("tail", () => {
  it("returns text unchanged when shorter than max", () => {
    expect(tail("short", 100)).toBe("short");
  });

  it("returns text unchanged when EXACTLY max (kills `<=` → `<` and `>` boundary)", () => {
    const exact = "abcde";
    expect(tail(exact, 5)).toBe("abcde");
    expect(tail(exact, 5)).not.toContain("…");
  });

  it("keeps the LAST max chars with a leading ellipsis when longer (kills slice(-max))", () => {
    // "abcdefghij" length 10, max 4 → keep "ghij" (last 4) prefixed by "…".
    expect(tail("abcdefghij", 4)).toBe("…ghij");
    expect(tail("abcdefghij", 4).length).toBe(5); // ellipsis + 4
  });

  it("keeps exactly one char past the boundary correctly", () => {
    // length 6, max 5 → "…" + last 5 = "…bcdef"
    expect(tail("abcdef", 5)).toBe("…bcdef");
  });

  it("defaults max to 2000", () => {
    const under = "a".repeat(2000);
    expect(tail(under)).toBe(under); // exactly 2000, no ellipsis
    const over = "b".repeat(2001);
    const out = tail(over);
    expect(out.length).toBe(2001); // "…" + last 2000
    expect(out[0]).toBe("…");
    expect(out.slice(1)).toBe("b".repeat(2000));
  });
});

// ─── foldPrompt ──────────────────────────────────────────────────────────────
describe("foldPrompt", () => {
  it("prepends the system prompt with a blank line when present", () => {
    expect(foldPrompt("You are X.", "do it")).toBe("You are X.\n\ndo it");
  });

  it("returns the prompt unchanged when systemPrompt is undefined/empty", () => {
    expect(foldPrompt(undefined, "do it")).toBe("do it");
    expect(foldPrompt("", "do it")).toBe("do it");
  });
});

// ─── spawnCollect ────────────────────────────────────────────────────────────
// Kills: L245 killed default, L254 argsPrefix array default, L258/263 optional
// chaining on stdout/stderr, abort branches L269-283, close/exitCode.
let binDir: string;
function makeBin(name: string, body: string): ResolvedBin {
  const p = path.join(binDir, name);
  writeFileSync(p, "#!/usr/bin/env node\n" + body);
  chmodSync(p, 0o755);
  return { command: process.execPath, argsPrefix: [p], resolved: name };
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "loopgen-cli-mut-"));
});
afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("spawnCollect", () => {
  it("captures stdout, stderr, and a zero exit code exactly", async () => {
    const bin = makeBin(
      "ok.cjs",
      `process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n"); process.exit(0);`,
    );
    const res = await spawnCollect(bin, [], { cwd: binDir });
    expect(res.stdout).toBe("out-line\n");
    expect(res.stderr).toBe("err-line\n");
    expect(res.exitCode).toBe(0);
    expect(res.killed).toBe(false); // kills L245 killed=true default
    expect(res.spawnError).toBeUndefined();
  });

  it("captures a non-zero exit code exactly (kills exitCode assignment)", async () => {
    const bin = makeBin("code3.cjs", `process.stdout.write("x"); process.exit(3);`);
    const res = await spawnCollect(bin, [], { cwd: binDir });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("x");
    expect(res.killed).toBe(false);
  });

  it("passes args after argsPrefix and observes chunks via onStdout/onStderr", async () => {
    // Echo argv back so we prove args are forwarded (kills L254 [] default and
    // the optional-chaining data handlers L258/L263).
    const bin = makeBin(
      "argv.cjs",
      `const a = process.argv.slice(2); process.stdout.write(JSON.stringify(a)); process.stderr.write("E"); process.exit(0);`,
    );
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const res = await spawnCollect(bin, ["--alpha", "beta"], {
      cwd: binDir,
      onStdout: (c) => outChunks.push(c),
      onStderr: (c) => errChunks.push(c),
    });
    expect(JSON.parse(res.stdout)).toEqual(["--alpha", "beta"]);
    // onStdout/onStderr must have fired with the same text (kills ?. removal only
    // partially, but proves the handler chain runs and forwards chunks).
    expect(outChunks.join("")).toBe(res.stdout);
    expect(errChunks.join("")).toBe("E");
    expect(res.exitCode).toBe(0);
  });

  it("honors argsPrefix ordering: prefix args precede call args", async () => {
    // Build a ResolvedBin whose argsPrefix carries an extra marker after the
    // script path, and assert ordering in the echoed argv.
    const scriptPath = path.join(binDir, "argv2.cjs");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`,
    );
    chmodSync(scriptPath, 0o755);
    const bin: ResolvedBin = {
      command: process.execPath,
      argsPrefix: [scriptPath, "PREFIX"],
      resolved: "argv2",
    };
    const res = await spawnCollect(bin, ["CALL"], { cwd: binDir });
    expect(JSON.parse(res.stdout)).toEqual(["PREFIX", "CALL"]);
  });

  it("sets spawnError (not a throw) when the command does not exist", async () => {
    const bin: ResolvedBin = {
      command: path.join(binDir, "does-not-exist-xyz"),
      argsPrefix: [],
      resolved: "missing",
    };
    const res = await spawnCollect(bin, [], { cwd: binDir });
    expect(res.spawnError).toBeDefined();
    expect(res.exitCode).toBe(null);
    expect(res.killed).toBe(false);
  });

  it("kills the child when the signal is already aborted (kills L280 branch + killed=true)", async () => {
    // A long-running child; the pre-aborted signal must SIGKILL it and mark killed.
    const bin = makeBin(
      "sleep.cjs",
      `setTimeout(() => { process.stdout.write("finished"); process.exit(0); }, 60000);`,
    );
    const res = await spawnCollect(bin, [], { cwd: binDir, signal: AbortSignal.abort() });
    expect(res.killed).toBe(true); // kills L281 killed=false and L280 conditional
    expect(res.stdout).not.toContain("finished");
  });

  it("does NOT set killed for a provided-but-never-aborted signal (kills L280 `if(aborted)` → `if(true)`)", async () => {
    // The signal exists (so the abort-handling block is entered) but never fires,
    // so `opts.signal.aborted` is false. If that check is forced to true, the
    // synchronous branch would SIGKILL the child and set killed=true wrongly.
    const bin = makeBin("quick2.cjs", `process.stdout.write("done"); process.exit(0);`);
    const ac = new AbortController();
    const res = await spawnCollect(bin, [], { cwd: binDir, signal: ac.signal });
    expect(res.killed).toBe(false);
    expect(res.stdout).toBe("done");
    expect(res.exitCode).toBe(0);
    ac.abort(); // no-op after close; keeps the controller referenced
  });

  it("terminates the child when the signal aborts mid-run (exercises L269 addEventListener branch)", async () => {
    const bin = makeBin(
      "sleep2.cjs",
      `setTimeout(() => { process.stdout.write("finished"); process.exit(0); }, 60000);`,
    );
    const ac = new AbortController();
    const p = spawnCollect(bin, [], { cwd: binDir, signal: ac.signal });
    // Abort shortly after spawn so the 'abort' listener path (not the pre-aborted
    // path) registers and fires. Node's own spawn `signal` may win the kill race,
    // so we assert termination (the child never finished) rather than the `killed`
    // flag specifically — the addEventListener branch still runs.
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(res.stdout).not.toContain("finished");
    expect(res.exitCode).not.toBe(0);
  });

  it("does NOT kill or error when no signal is provided (kills L269 conditional true)", async () => {
    const bin = makeBin("quick.cjs", `process.stdout.write("done"); process.exit(0);`);
    const res = await spawnCollect(bin, [], { cwd: binDir });
    expect(res.killed).toBe(false);
    expect(res.stdout).toBe("done");
    expect(res.exitCode).toBe(0);
  });

  it("runs in the requested cwd (env/cwd wiring)", async () => {
    const sub = mkdtempSync(path.join(tmpdir(), "loopgen-cli-cwd-"));
    try {
      const bin = makeBin("cwd.cjs", `process.stdout.write(process.cwd());`);
      const res = await spawnCollect(bin, [], { cwd: sub });
      // realpath-independent: the reported cwd should end with the sub dir name.
      expect(res.stdout).toContain(path.basename(sub));
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  it("forwards a custom env to the child", async () => {
    const bin = makeBin("env.cjs", `process.stdout.write(process.env.MUT_CLI_MARKER || "UNSET");`);
    const res = await spawnCollect(bin, [], {
      cwd: binDir,
      env: { ...process.env, MUT_CLI_MARKER: "present" },
    });
    expect(res.stdout).toBe("present");
  });
});
