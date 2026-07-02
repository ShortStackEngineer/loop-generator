// Correctness gate — paired with the macro-F1 metric so the loop can't "win" by
// breaking the module (a classifier that throws, or returns junk, could otherwise
// still move a number). Run with the zero-dependency built-in runner: `node --test`.
//
// This file is part of the success contract, so it is GUARDED too: the agent
// shouldn't weaken these assertions to pass.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../src/classify.mjs";

const LABELS = new Set(["positive", "negative"]);
const here = path.dirname(fileURLToPath(import.meta.url));
const train = readFileSync(path.join(here, "..", "data", "train.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test("classify is a function", () => {
  assert.equal(typeof classify, "function");
});

test("classify returns a valid label for every training input, without throwing", () => {
  for (const { text } of train) {
    const out = classify(text);
    assert.ok(LABELS.has(out), `classify(${JSON.stringify(text)}) returned ${JSON.stringify(out)}`);
  }
});

test("classify handles empty and non-obvious input without throwing", () => {
  for (const text of ["", "   ", "the item arrived on tuesday"]) {
    assert.ok(LABELS.has(classify(text)));
  }
});
