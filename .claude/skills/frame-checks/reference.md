# frame-checks — reference

Depth behind `SKILL.md`: a full worked transformation, the driver-vs-guard
distinction, the evidence-type guide, the "how a green lies" catalog, more
category examples, and the loop-generator hand-off format.

## Worked transformation

**Request:** "Make the CSV export not choke on big files."

**1. Observable outcomes (not actions).** Today a large export loads every row
into memory and times out / OOMs. Done means:

> Exporting a dataset of any size completes, produces a byte-correct CSV, and
> holds memory roughly flat regardless of row count.

**2. Claims, across the three axes:**

| axis | claim |
|---|---|
| new behavior | a 1,000,000-row export completes and the file has 1,000,001 lines (header + rows) |
| new behavior | a spot-checked row in the large export has the exact expected fields |
| invariant | a small fixture export is byte-identical to today's output (format unchanged) |
| invariant | peak memory during a large export stays under a fixed ceiling (doesn't scale with rows) |
| edge | an empty dataset exports a header-only file |
| edge | a field containing `,` `"` or newline is RFC-4180-quoted |

**3. Evidence types:**

- large-export completeness, spot-row, empty, quoting → **deterministic** tests.
- format-unchanged → **deterministic** golden-file test.
- memory ceiling → **empirical** (measure peak RSS over the export; assert `<` ceiling).

**4. RED / GREEN now (driver vs guard):**

- The large-export test and the memory-ceiling measurement are **drivers** — RED
  today (it times out / RSS blows the ceiling). Good.
- The golden-file and quoting tests are **guards** — GREEN today; they'd only go
  RED if the streaming rewrite changed the output format. Legitimate to keep.
- The empty-dataset test — check which it is. If empty export already works, it's
  a guard; if it currently errors, it's a driver. Label it honestly.

**5. How could a green lie?**

- *Large-export test passes by writing 1,000,001 blank lines.* → also assert the
  spot-row content and a checksum of a known slice, not just the line count.
- *Memory "passes" because the measurement warms up after the peak.* → sample RSS
  continuously and take the max; fix the dataset and the run.
- *Format guard passes because the fixture is trivial.* → use a fixture that
  exercises quoting and a multi-type row.

**6. Coverage.** Greens ⇒ delivered? The union covers correctness, the
performance goal, no-format-regression, and the two edges. Gap: does "any size"
include *streaming to the client* vs *to a file*? If the real path streams over
HTTP, add a claim for the response path or state it's out of scope. Name it.

**7. Deliverable** — see the hand-off format at the bottom.

## Driver checks vs guard checks

Every check is one of two kinds. Labeling them is what makes step 4 correct.

| | **driver** | **guard** |
|---|---|---|
| encodes | the new behavior | an invariant that must survive |
| state now | **RED** | **GREEN** |
| turns | GREEN when delivered | RED if the change regresses it |
| if it's green now | it doesn't test the change — drop/tighten | correct — that's its job |

A healthy check set has **≥ 1 red driver** and enough guards to fence the
regression surface. All-green-now = nothing new is being verified (in
loop-generator, `baseline: strict` fails exactly this). All-drivers, no guards =
a green that can ship a regression unseen.

**Watch the trap:** a *new feature's own safety rails* ("the retry must not
relaunch a tampered run") read like invariants but are **drivers** — RED now,
because the rail doesn't exist until you build it. Only behavior that already
works is a green-now guard.

## Evidence-type guide

Decide per claim: *who decides pass/fail, how repeatably?*

**Deterministic (prefer).** A machine decides, same answer every run.
- test asserting behavior · script exit code · schema / type / lint gate ·
  golden-file / snapshot · a `diff` against expected.
- Cheapest check that pins the behavior wins. Assert through the **real entry
  point**, not an internal shortcut.

**Empirical (the claim is a number).** Measure, compare to a threshold or a
baseline delta.
- latency / throughput · memory / bundle size · accuracy / F1 / precision ·
  coverage % · error rate.
- The number is only as trustworthy as the measurement: fix the input, control
  warm-up, repeat and aggregate (median/p95), and prefer a **delta vs a recorded
  baseline** over an absolute when the environment varies.

**Subjective (a human must judge).** Two honest moves, never a third:
- **Proxy it** — replace the judgment with an observable that stands in for it.
  "Delightful onboarding" → "new user reaches first value in ≤ 3 taps." "Readable
  code" → "passes the linter + the public API has doc comments." Only if the proxy
  honestly tracks the goal.
- **Manual gate** — mark it human review, keep it out of any automated success
  rule. A design/UX/copy call is a legitimate manual gate; don't launder it into a
  passing check.

## How a green lies — catalog

For each check, name the cheapest fake and close it.

| the fake | what it looks like | the counter |
|---|---|---|
| **hard-code the answer** | return the exact value the test expects; special-case the test's input | assert on inputs the fix can't enumerate; use a held-out / randomized case; check via the real entry point |
| **weaken the assertion** | loosen `==` to `~=`, widen a tolerance, drop a case, `assert True` | pin the exact contract; in a loop make the test files tamper-evident (`evaluatorGuard: error` + `guard:`) |
| **self-fulfilling fixture** | create the record, then assert it exists — never drives the feature | exercise the real path end to end; assert an effect only the feature produces |
| **narrow the scope** | make the one named input pass, not the general behavior | test the general property (multiple/property-based inputs), not the example |
| **move the goalpost** | edit the check, threshold, or spec instead of the code | treat checks as immutable; guard the spec + test files; score on a frozen dataset |
| **green by omission** | skip/`xfail`/empty test, `|| true`, swallow the error, exit 0 on failure | assert a positive effect; fail closed; check the exit code *and* an output artifact |
| **overfit the metric** | memorize the dev split; tune to the exact benchmark | score the pass metric on a **held-out split** the agent never sees; report only the score |

The through-line: **a check is good when the only way to turn it green is to build
the thing.** If a cheaper path exists, the check — not the code — is the problem.

## More category examples

**Bug fix** — "Fix the crash when `parse()` gets an empty string."
- driver: `parse("")` returns the documented empty result (RED: it throws today).
- guard: the existing `parse()` suite stays green (no behavior change for valid input).
- edge: whitespace-only string, and a string that's *almost* valid.
- lie to close: a test that only checks "doesn't throw" — also assert the *value*.

**Performance** — "Make the dashboard query fast."
- sharpen: fast = p95 under 200 ms on the 10k-row fixture.
- driver: empirical — measure p95 over the fixed query set; assert `< 200 ms`
  (RED: it's ~900 ms today). Record a baseline; assert the delta if the box varies.
- guard: result set is byte-identical to the slow query (correctness preserved) —
  deterministic golden test.
- lie to close: "fast" by returning fewer rows → the correctness guard catches it.

**Refactor / API change** — "Clean up the `Client` API."
- this is mostly *invariants*: public methods unchanged (or a documented,
  tested migration), the suite green, types still compile, no new deprecation.
- driver (if there's a real goal): the specific smell removed — e.g. "no method
  over 40 lines" (lint rule, RED now) — otherwise this may be judgment, not a loop.
- honest verdict: if "clean" has no falsifiable core, say so and propose the one
  or two measurable sub-goals that do.

**Eval / model task** — "Improve the classifier's accuracy."
- sharpen: macro-F1 ≥ 0.85 on the held-out test set.
- driver: empirical — scorer prints F1 as JSON; assert `≥ 0.85` (RED: stub scores ~0.6).
- guard: a `command` gate that the module still returns a valid label for every
  input (can't "win" by emitting junk).
- lie to close: overfit the dev split → score on labels the agent is told not to
  train on and never sees in feedback; make the scorer + datasets tamper-evident.
- templates: `examples/projects/eval-classifier`, `examples/projects/eval-prompt`.

## Hand-off format

Deliver an ordered list. Per check:

- **claim** — the outcome in one testable sentence
- **kind** — driver (RED now) or guard (GREEN now)
- **evidence** — deterministic | empirical | manual
- **why RED/GREEN now** — the concrete reason (behavior absent / invariant holds)
- **anti-gaming** — the cheapest fake and how this check resists it
- **check** — the concrete command, assertion, or metric+threshold

Plus a **coverage line** — "green on all of the above ⇒ <request> is delivered,
except <named gaps>" — and, for any un-checkable piece, an explicit **manual
gate** note.

### → loop-generator mapping

| frame-checks | author-loop / spec |
|---|---|
| deterministic driver/guard | a `command` evaluator (exit code = verdict) |
| empirical driver | an `experiment` evaluator (`metric`, `direction`, `minValue`/`maxValue`/`minDelta`) |
| "≥ 1 red driver, guards green" | passes `baseline: strict` (the set isn't vacuous) |
| anti-gaming: freeze the checks | `evaluatorGuard: error` + each check's `guard:` paths |
| anti-gaming: held-out split | score the pass metric on data reported only as a number |
| manual gate | *not* in `success` — human review, outside the loop |

Hand the list to **author-loop**; it inspects the real repo, wires the real
commands, sets the trust policy, and proves lint-clean + starts-RED before any
agent budget is spent. The RED-now reasoning you already did is that gate,
front-loaded.
