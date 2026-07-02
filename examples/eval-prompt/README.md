# eval-prompt — optimize a prompt to an exact-match bar (needs a live model)

Optimize a prompt against a live model: a labeled task set, an LLM under test,
and an exact-match score. An agent edits `project/prompt.txt` until the intent
classifier reaches **0.90 exact-match accuracy**, changing the prompt only and
never the eval.

```
project/
  prompt.txt        the prompt the agent optimizes (vague stub → RED baseline)
  eval/run.mjs      calls an OpenAI-compatible model, scores exact-match  (guarded)
  data/tasks.jsonl  labeled input→gold intents (closed label set)          (guarded)
```

Unlike `eval-classifier`, this loop needs a **running model**. The
scorer speaks the OpenAI-compatible chat API and defaults to LM Studio on
localhost, so it runs keyless against a locally-served model. Configure via env:

```bash
export OPENAI_BASE_URL=http://localhost:1234/v1   # default (LM Studio)
export OPENAI_API_KEY=not-needed                  # default; local servers ignore it
export EVAL_MODEL=google/gemma-4-26b-a4b-qat      # the loaded model id — set this

# Run the eval directly, without an agent:
cd examples/eval-prompt/project
node eval/run.mjs        # stub prompt: accuracy ≈ 0 (the model free-forms)

# Or run the full loop (also needs an agent driver to optimize the prompt):
loopgen run examples/eval-prompt/exact-match.loop.yaml
```

Accuracy improves through ordinary prompt engineering: enumerate the exact
labels and pin the output format. `prompt.txt` is the only file an agent may
edit — the scorer, label space, and gold answers under `eval/` and `data/` are
**guarded** (`evaluatorGuard: error`). See
[`exact-match.loop.yaml`](./exact-match.loop.yaml) for the full spec.
