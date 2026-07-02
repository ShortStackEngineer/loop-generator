# eval-classifier — optimize a classifier to a macro-F1 bar (offline)

A self-contained, **zero-dependency** eval target and the loop that optimizes it.
An agent improves the sentiment classifier in `project/src/classify.mjs` until it
reaches **macro-F1 ≥ 0.80** on a held-out split, without editing the eval or the
labels.

```
project/
  src/classify.mjs        the model the agent edits (empty lexicon → RED baseline)
  eval/score.mjs          the scorer; prints {"macro_f1": ...}  (guarded)
  data/train.jsonl        dev split the agent may study
  data/holdout.jsonl      held-out split the pass metric is scored on  (guarded)
  test/contract.test.mjs  correctness gate: valid label, never throws  (guarded)
```

Run it (needs an agent driver — Claude Agent SDK with `ANTHROPIC_API_KEY`, or grok):

```bash
npm run loopgen -- lint examples/projects/eval-classifier/sentiment-f1.loop.yaml
npm run loopgen -- run  examples/projects/eval-classifier/sentiment-f1.loop.yaml
```

Poke at the target directly, no agent needed:

```bash
cd examples/projects/eval-classifier/project
node eval/score.mjs data/holdout.jsonl   # baseline: macro_f1 ≈ 0.33
node --test                              # contract test (passes on the stub)
```

The guards are what keep the metric honest. The scorer and both datasets are
**guarded** (`evaluatorGuard: error`), so the classifier is the only lever an
agent has — editing the labels or the scoring to move the number aborts the run
as tampering. `baseline: strict` requires the eval to start RED, and the pass
metric is scored on a **held-out** split the agent is told not to train on. That
is what keeps "optimize until the number passes" from being gamed. The header of
[`sentiment-f1.loop.yaml`](./sentiment-f1.loop.yaml) documents the full setup.
