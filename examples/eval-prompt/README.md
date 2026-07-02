# eval-prompt — optimize a prompt to an exact-match bar (needs a live model)

The modern "eval": a labeled task set, an LLM under test, and a score you push up
by improving the **prompt**. The task: optimize `project/prompt.txt` until an
intent classifier reaches **0.90 exact-match accuracy** — by editing the prompt
only, never the eval.

```
project/
  prompt.txt        the prompt the agent optimizes (vague stub → RED baseline)
  eval/run.mjs      calls an OpenAI-compatible model, scores exact-match  (guarded)
  data/tasks.jsonl  labeled input→gold intents (closed label set)          (guarded)
```

Unlike the sibling `eval-classifier`, this one needs a **running model**. The
scorer speaks the OpenAI-compatible chat API and defaults to LM Studio on
localhost, so it runs keyless against a locally-served model. Configure via env:

```bash
export OPENAI_BASE_URL=http://localhost:1234/v1   # default (LM Studio)
export OPENAI_API_KEY=not-needed                  # default; local servers ignore it
export EVAL_MODEL=google/gemma-4-26b-a4b-qat      # the loaded model id — set this

# Poke at the target directly (no agent), to feel the loop:
cd examples/eval-prompt/project
node eval/run.mjs        # stub prompt: accuracy ≈ 0 (the model free-forms)

# Or drive the loop (also needs an agent driver for the optimizer):
loopgen run examples/eval-prompt/exact-match.loop.yaml
```

The number moves through real prompt engineering — enumerate the exact labels,
pin the output format. `prompt.txt` is the only file the agent may edit; the
scorer, label space, and gold answers under `eval/` and `data/` are **guarded**
(`evaluatorGuard: error`). See [`exact-match.loop.yaml`](./exact-match.loop.yaml).
