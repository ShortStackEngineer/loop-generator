// The eval harness for a PROMPT optimization loop. The system under test is a
// live LLM; the thing being optimized is prompt.txt (the agent's only lever).
// This runner is the CHECKER and is guarded — the agent can't rewrite the scoring.
//
// Unlike the offline classifier example, this one needs a running model. It speaks
// the OpenAI-compatible chat API, so it works against LM Studio (default), Ollama,
// vLLM, or any hosted endpoint. Configure via env:
//   OPENAI_BASE_URL  default http://localhost:1234/v1   (LM Studio)
//   OPENAI_API_KEY   default "not-needed"               (local servers ignore it)
//   EVAL_MODEL       the loaded model id, e.g. google/gemma-4-26b-a4b-qat
//
// Contract with loopgen's `experiment` evaluator: print ONE JSON object to stdout
// and nothing else. It reads `accuracy`.
//   node eval/run.mjs
//   -> {"accuracy":0.4,"valid_label_rate":0.6,"n":20,"model":"..."}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1";
const KEY = process.env.OPENAI_API_KEY ?? "not-needed";
const MODEL = process.env.EVAL_MODEL ?? "local-model";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const systemPrompt = readFileSync(path.join(root, "prompt.txt"), "utf8").trim();
const tasks = readFileSync(path.join(root, "data", "tasks.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// The fixed label space. Exact-match is only fair when the target is closed, so
// this is part of the graded contract, not something the prompt can redefine.
const LABELS = new Set(["refund", "password_reset", "track_order"]);

const normalize = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.'"`]+$/g, "")
    .replace(/\s+/g, "_");

async function predict(input) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat/completions ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

let correct = 0;
let valid = 0;
try {
  for (const { input, gold } of tasks) {
    const pred = normalize(await predict(input));
    if (LABELS.has(pred)) valid++;
    if (pred === gold) correct++;
  }
} catch (err) {
  process.stderr.write(`eval failed: ${err.message}\n`);
  process.exit(1);
}

const round = (x) => Math.round(x * 1e4) / 1e4;
process.stdout.write(
  JSON.stringify({
    accuracy: round(correct / tasks.length),
    valid_label_rate: round(valid / tasks.length),
    n: tasks.length,
    model: MODEL,
  }) + "\n",
);
