// The eval harness — the CHECKER half of the loop. It is deliberately separate
// from the classifier the agent edits (maker ≠ checker), and it is GUARDED by the
// spec's `evaluatorGuard`, so an agent can't quietly rewrite the scoring rules or
// the labels to make the number go up.
//
// Contract with loopgen's `experiment` evaluator: print ONE JSON object to stdout
// and NOTHING else. The evaluator parses stdout and reads `macro_f1`.
//
//   node eval/score.mjs data/holdout.jsonl
//   -> {"macro_f1":0.33,"accuracy":0.5,"n":30,"per_class":{...},"dataset":"..."}
//
// macro-F1 is the mean of each class's F1, so it can't be gamed by predicting the
// majority label — the ignored class scores 0 and drags the mean down.

import { readFileSync } from "node:fs";
import path from "node:path";
import { classify } from "../src/classify.mjs";

const datasetArg = process.argv[2];
if (!datasetArg) {
  process.stderr.write("usage: node eval/score.mjs <dataset.jsonl>\n");
  process.exit(2);
}

const datasetPath = path.resolve(process.cwd(), datasetArg);
const rows = readFileSync(datasetPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Classes are data-driven: whatever gold labels appear in the dataset.
const classes = [...new Set(rows.map((r) => r.label))].sort();
const stat = new Map(classes.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));

let correct = 0;
for (const { text, label } of rows) {
  const pred = classify(text);
  if (pred === label) correct++;
  for (const c of classes) {
    const s = stat.get(c);
    if (pred === c && label === c) s.tp++;
    else if (pred === c && label !== c) s.fp++;
    else if (pred !== c && label === c) s.fn++;
  }
}

const div = (a, b) => (b === 0 ? 0 : a / b);
const round = (x) => Math.round(x * 1e4) / 1e4;

const perClass = {};
let f1Sum = 0;
for (const c of classes) {
  const { tp, fp, fn } = stat.get(c);
  const precision = div(tp, tp + fp);
  const recall = div(tp, tp + fn);
  const f1 = div(2 * precision * recall, precision + recall);
  perClass[c] = { precision: round(precision), recall: round(recall), f1: round(f1), support: tp + fn };
  f1Sum += f1;
}

const out = {
  macro_f1: round(f1Sum / classes.length),
  accuracy: round(div(correct, rows.length)),
  n: rows.length,
  per_class: perClass,
  dataset: path.basename(datasetPath),
};

process.stdout.write(JSON.stringify(out) + "\n");
