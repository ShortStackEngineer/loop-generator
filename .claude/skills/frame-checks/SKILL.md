---
name: frame-checks
description: >-
  Turn a request, feature, or task into falsifiable acceptance checks — a
  definition of done written as checks that fail now and pass only when the thing
  is actually delivered. Decompose the ask into independently verifiable claims
  (the new behavior, the invariants that must not break, the edges), give each an
  evidence type (an automated test, a measured metric, or a flagged human
  judgment), confirm each is RED on today's code, then adversarially harden each
  so a passing check can't be faked. The output is a check list that can anchor a
  definition of done or a test plan, or feed loop-generator's author-loop. Use
  when a request is vague or "make X better," when someone asks "how would we know
  this is done?", when writing acceptance criteria / a definition of done / a test
  plan, or before authoring a .loop.yaml.
---

# frame-checks

Most requests are phrased as **actions** — "add retry," "make search better,"
"clean up the API." You can't verify an action; you can only verify an
**outcome**. This skill converts a request into the checks that would prove it's
done: each one false now, true only when the real thing exists, and hard to fake.

It's the discipline behind any trustworthy "done" — a PR's acceptance criteria, a
test plan, or the evaluators of an agent loop. Worked transformations, the
"how a green lies" catalog, the evidence-type guide, and the loop-generator
mapping live in `reference.md`; read it when you want detail or examples.

## The one rule

**A check that encodes the request earns its place only if it is RED now and can
turn GREEN only by delivering the real thing.** (Invariant checks are the mirror
image — GREEN now, and they earn their place by turning RED if the change breaks
them.)

A behavior check that already passes verifies nothing. One a one-line fake can
satisfy verifies almost nothing. Everything below serves those two properties.
And the honest failure mode is a feature: **if you can't write a single check
that's red before the work, the request isn't ready to build — say so.**

## Workflow

### 1. Restate the ask as observable outcomes, not actions

Rewrite each "do X" as "X is observably true." The test is: could a stranger,
given only the codebase and your sentence, tell whether it holds?

- "Add retry to `fetchUser`" → "`fetchUser` returns the user after up to N
  transient failures, and gives up (surfacing the error) after N."
- "Make search better" → *unusable until sharpened.* Push: better how — matches
  more? ranks higher? faster? Land on "a case-insensitive substring of a name
  matches that user" (checkable) before going further.

If an outcome resists this rewrite, it's probably subjective — flag it now
(step 3), don't smuggle it in as if it were checkable.

### 2. Decompose into independent claims

Break the outcome into the smallest claims that can each be checked on their own.
Cover three axes — most requests need all three:

- **New behavior** — the thing being asked for, working.
- **Protected invariants** — what must *not* break. The regression surface: the
  existing suite still green, the public signature unchanged, no new error path.
- **Edges** — the boundaries named or implied: empty input, the retry budget
  exhausted, the Nth item, concurrent callers, the failure that should propagate.

A request "done" only when the union of these holds. Skipping invariants is how a
green run ships a regression.

### 3. Give each claim an evidence type

Ask, per claim: **who or what decides pass/fail, and how repeatably?**

- **Deterministic** — a machine decides, unambiguously and repeatably: a test
  asserting the behavior, a script's exit code, a schema/type/lint gate. *Prefer
  this.* Pin the behavior with the cheapest deterministic check that captures it.
- **Empirical** — the claim *is* a number: latency, bundle size, accuracy,
  coverage. Measure it and compare to a threshold or a baseline delta. Nail down
  the measurement (fixed input, warm-up, repeats) so the number is trustworthy.
- **Subjective** — a human must judge ("is the UX delightful," "is the API
  ergonomic"). You have two honest moves: find a proxy that *isn't* subjective
  ("delightful onboarding" → "a new user reaches first value in ≤ 3 taps," which
  is checkable), or mark it a **manual gate** and keep it out of any automated
  success rule. Never dress a judgment up as a passing check.

### 4. Prove each check can fail — for the right reason

**Behavior checks** (the ones encoding the request) must be **RED now**: run them
if you can, reason it through if you can't, and confirm each fails because the
behavior is absent — not because a binary is missing, the cwd is wrong, or the
command is bogus. A behavior check that's already green doesn't encode the
change; tighten it or drop it.

**Invariant checks** are the mirror: **GREEN now**, and load-bearing precisely
because they'd go red if the change regressed them (sanity-check by imagining the
break). The set as a whole must hold at least one currently-red behavior check —
a suite that's green from the start is the most common way "all checks passed"
becomes a lie.

### 5. Adversarial pass — "how could a green lie?"

For each check, name the **cheapest fake** that satisfies it without doing the
real work, then close it. The catalog and counters are in `reference.md`; the
common shapes:

- hard-code the expected output / special-case the test's input → assert via the
  **real entry point**, use inputs the fix can't enumerate;
- weaken the assertion or widen the tolerance → pin the exact contract;
- test the fixture, not the feature (self-fulfilling) → drive the real path end
  to end;
- move the goalpost by editing the check/threshold itself → treat the checks as
  immutable (in a loop: guard the test files, hold out the scoring split).

If the only way to turn a check green is to build the thing, it's a good check.

### 6. Coverage check

Step back: **if every check is green, is the request delivered?** Walk the
original ask against the check list. Name anything the greens *don't* imply — an
unhandled path, an invariant you didn't pin, a claim you left subjective. Either
add a check or state the gap explicitly. A passing set that doesn't span the ask
is a false done.

### 7. Deliver the check list

Hand back an ordered list; per check: the **claim**, its **evidence type**, **why
it's RED now**, the **anti-gaming note**, and the **concrete command or metric**.
If part of the ask has no falsifiable core, deliver the checkable part *plus* an
explicit "this piece is a human judgment, not a check, because …". That verdict
is a valid, useful result — not a failure to finish.

## Feeding it to a loop

When the checks will drive a loopgen loop, the mapping is direct:

- **deterministic** check → a `command` evaluator (its exit code is the verdict);
- **empirical** check → an `experiment` evaluator (metric vs threshold/baseline);
- **subjective / manual** check → *not* a loop success gate — it's human review.
  If every check is subjective, the task isn't a loop. Say so.

The RED-now confirmation you did per check (step 4) is exactly author-loop's
prove-RED gate, done early. Hand the check list to **author-loop**, which turns it
into a lint-clean, starts-RED `.loop.yaml` against the real repo. The
`evaluatorGuard` / held-out-split moves from step 5 are what make those checks
tamper-evident once an agent is grinding against them.

## Guardrails

- **An action is not a check.** "Refactor `X`" is a task; "`X`'s public API is
  unchanged and the suite stays green" is a check. Convert every one.
- **Never keep a check that's green now.** It's decoration, and worse, it's
  decoration that reads as verification.
- **Name what you don't cover.** Silent gaps are how a passing run ships a miss.
- **Don't fake falsifiability.** If the ask is genuinely a judgment call, say so;
  proxy-metric it only when the proxy honestly stands in for the goal.
- **Cheapest check that pins the behavior wins.** Reach for a measured metric only
  when the thing itself is a number.
