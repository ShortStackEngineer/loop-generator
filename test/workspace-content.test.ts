import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotContent, diffContent, DEFAULT_IGNORE_GLOBS } from "../src/core/workspace";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopgen-content-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("content-hash change detection", () => {
  it("detects added, modified, and deleted files", () => {
    writeFileSync(path.join(dir, "a.txt"), "one");
    writeFileSync(path.join(dir, "b.txt"), "keep");
    const before = snapshotContent(dir);
    writeFileSync(path.join(dir, "a.txt"), "two");
    writeFileSync(path.join(dir, "c.txt"), "new");
    rmSync(path.join(dir, "b.txt"));
    const after = snapshotContent(dir);
    const diff = diffContent(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.files.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(diff.stat).toMatch(/3 file/);
  });

  it("returns no change when content is identical", () => {
    writeFileSync(path.join(dir, "a.txt"), "same");
    const before = snapshotContent(dir);
    const after = snapshotContent(dir);
    expect(diffContent(before, after)).toEqual({ changed: false, files: [], stat: "" });
  });

  it("skips node_modules and default ignore globs", () => {
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "skip");
    writeFileSync(path.join(dir, "app.log"), "noise");
    writeFileSync(path.join(dir, "src.ts"), "real");
    const snap = snapshotContent(dir, DEFAULT_IGNORE_GLOBS);
    expect([...snap.keys()]).toEqual(["src.ts"]);
  });
});
