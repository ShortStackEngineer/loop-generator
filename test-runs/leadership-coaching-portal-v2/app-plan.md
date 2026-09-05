# Leadership Coaching Client Portal v2 — build plan

**Experiment intent (vs v1):** exercise the *feedback loop*, not only the
verification stack. v1 one-shotted every node because requirements transcribed
the HTTP contract. v2:

1. **Hardens obligation invariants** into negative checks on every new surface
   (especially *client session → coach API → 403* — the gap v1 missed).
2. **Underspecifies mid/late requirements** (product outcomes, not route maps);
   the pre-seeded suite is the sole contract the agent must discover via feedback.
3. **Adds behavioral depth**: opt-in note sharing (toggle + portal), malformed
   JSON → 400, role-gated coach surfaces.

**Source ask:** An app for a leadership coach’s clients: proprietary 360 survey
results, focus areas, notes from calls, feedback, a coaching plan, and
recommendations (books, podcasts, etc.) — each client can access their *shared*
content.

**Actors:** Coach · Client  
**Stack (seated by N1):** TypeScript · Express · cookie sessions · JSON file
store · Node test runner + supertest

---

## Invariants

**Regression guards**

- cumulative acceptance suite stays green
- public contracts of shipped slices unchanged
- `npm run typecheck` clean

**Obligation invariants** (fresh RED check on each *new surface* they touch)

| id | rule | negative check shape |
|----|------|----------------------|
| O1 | **auth required** | no cookie → 401 on every protected route |
| O2 | **tenant isolation** | coach B cannot read/write coach A’s clients (404/403) |
| O3 | **role separation** | client session cannot use coach APIs (403) — *every* coach surface |
| O4 | **opt-in sharing** | notes/feedback private by default; appear on portal **only after** explicit share; coach-only fields never leak |
| O5 | **client scope** | client A cannot observe client B’s portal data |
| O6 | **safe errors** | malformed JSON body → 400 (not 500); auth responses never leak password material |

---

## Nodes

| id | outcome | needs | status |
|----|---------|-------|--------|
| N1 | Coach registers, logs in, reaches authenticated session; bad JSON → 400 | — | frontier |
| N2 | Coach creates/lists clients; **client role cannot create clients** | N1 | planned |
| N3 | Coach records 360 on owned client; client role blocked | N2 | planned |
| N4 | Coach sets focus areas; client role blocked | N2 | planned |
| N5 | Coach adds call notes (private default) + **share toggle**; client role blocked | N2 | planned |
| N6 | Coach adds feedback (private default) + share toggle; client role blocked | N2 | planned |
| N7 | Coach authors coaching plan; client role blocked | N2 | planned |
| N8 | Coach adds recommendations; client role blocked | N2 | planned |
| N9 | Coach grants portal access; client reaches portal identity | N2 | planned |
| N10 | Portal home: shared content only; shared notes appear after toggle; private omitted | N3–N9 | planned |

### Design notes

- **N1 requirements** stay moderately concrete (skeleton needs an entry point).
- **N2–N10 requirements** are *outcome language only* — no route tables, no
  status-code laundry lists. Contract lives in `test/acceptance/**` so the agent
  must read failures / feedback to converge (multi-iteration signal).
- Share mechanism is a first-class axis of N5/N6 and re-checked on N10.
- Role separation is an **obligation on every coach surface**, not a single N2 check.

### Not nodes

| fragment | routing |
|----------|---------|
| JSON store / sessions | artifact of N1 |
| “build API layer” | rides vertical slices |
| UX polish | manual gate |

---

## Frontier: { N1 }

### N1 axes + RED proof

1. Register/login/me for coaches  
2. 401 without session  
3. Duplicate email 409 (case-insensitive)  
4. Wrong password 401; no password leak  
5. Malformed JSON → 400 on POST bodies  

```bash
cd app && npm run test:n1   # all fail: routes absent / wrong status
```

---

## Re-plan log

- 2026-08-08: v2 spun from v1 review — role-separation gap, null feedback-loop
  experiment, dead `sharedWithClient` flag, missing 400-on-bad-JSON.
- Pre-seeded full suite under `app/test/acceptance/`; cumulative `test:nK`.
- 2026-08-08 batch **PASSED** 10/10 (~524s, ~$1.77, grok). Suite 35/35 green.
  Implementation includes `requireCoach` on every coach surface, live PATCH
  share toggles, portal filters `sharedWithClient === true`, JSON syntax → 400.
  **Still all one-shot (1 iter/node):** outcome-only requirements were not
  enough to force multi-iteration — the agent reads the in-workspace tests and
  implements the contract in a single pass. Feedback-loop signal remains weak;
  next experiment should hide the grader from the agent (tests outside
  workspace + feedback-only) or use a weaker model / intentionally partial first
  stub the agent must repair.
