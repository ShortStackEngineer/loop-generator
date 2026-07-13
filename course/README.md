# Loop Generator Workshop

An interactive course teaching how `loop-generator` works: the engine mechanics, the trust model,
how the LLM is prompted initially vs. each iteration, and how to design evaluators.

## Run it

```bash
cd course
npm install
npm run dev      # local dev server
npm run build    # typecheck (strict) + production build to dist/
```

## What's inside

Seven modules, each ending in a quiz (70% marks it complete; progress persists in localStorage):

1. **The Big Picture** — clickable architecture diagram: spec → engine → the four plug-in points.
2. **Anatomy of a .loop.yaml** — field-by-field spec explorer + a success-criteria playground
   running the real `evaluateCriteria` logic.
3. **Inside the Engine Loop** — step-through simulator of six scripted runs (happy path, vacuous
   baseline, no-op green, spec tamper, budget exceeded, max-iterations).
4. **How the LLM Is Prompted** — live prompt builder using the exact assembly logic from
   `src/tasks/base.ts`: system vs. initial vs. iteration-feedback prompts.
5. **The Trust Model** — red-team playground: pick an attack, toggle guard policies, see what the
   engine does (including the two attacks that currently slip through).
6. **Designing Evaluators** — command/experiment evaluators in full, plus a "trustworthy or
   fake-able?" judging game.
7. **Capstone** — predict the outcome of six runs, then a final exam.

The demos don't call any API: `evaluateCriteria`, `buildFeedback`, and the prompt builders are
ported verbatim from `src/core/` and `src/tasks/` into `src/sim/`, so everything shown is real
engine behavior.
