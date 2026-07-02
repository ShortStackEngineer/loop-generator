# eval-classifier — optimize a classifier to a macro-F1 bar (offline)

A fully self-contained, **zero-dependency** eval target plus the loop that drives
it. The task: improve the sentiment classifier in `project/src/classify.mjs` until
**macro-F1 ≥ 0.80** on a held-out split, without touching the eval or the labels.

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
loopgen lint examples/eval-classifier/sentiment-f1.loop.yaml
loopgen run  examples/eval-classifier/sentiment-f1.loop.yaml
```

Poke at the target directly, no agent needed:

```bash
cd examples/eval-classifier/project
node eval/score.mjs data/holdout.jsonl   # baseline: macro_f1 ≈ 0.33
node --test                              # contract test (passes on the stub)
```

Why it's more than a metric loop: the scorer and both datasets are **guarded**
(`evaluatorGuard: error`), so the agent's only lever is the classifier — it can't
edit the labels or the scoring to move the number. `baseline: strict` proves the
eval starts RED, and the metric is scored on a **held-out** split the agent is
told not to train on. That's the anti-gaming story that makes "optimize until the
number passes" trustworthy. See the header of
[`sentiment-f1.loop.yaml`](./sentiment-f1.loop.yaml) for the full walkthrough.
