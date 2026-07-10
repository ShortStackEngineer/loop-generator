# Authoring a loop you can trust

> **Canonical version:**
> **<https://shortstackengineer.github.io/loop-generator/docs/authoring.html>**
> This file is a stub — the site page is the full, maintained guide. Edit
> `site/docs/authoring.html`, not this file.

A `.loop.yaml` that parses isn't necessarily one worth running. The guide covers
authoring a spec that's **runnable and trustworthy** — one whose checks actually
test the requirement and start RED before the agent begins:

- **When a loop fits (and when it doesn't)** — best-fit tasks, poor fits, and
  the four limits no guard can eliminate.
- **The one rule:** every check must (a) test the requirement and (b) be RED
  before the agent starts.
- The six steps: pin down the goal → inspect the target repo for the *real*
  commands → decide the spec (guards, baseline, budget) → generate then edit →
  **prove it** (lint clean + checks start RED, zero agent budget) → run it.

If you use Claude Code, the in-repo `author-loop` skill
(`.claude/skills/author-loop/`) runs these steps for you; its `reference.md`
has the exact field/default tables. Schema source of truth: `src/core/spec.ts`.
