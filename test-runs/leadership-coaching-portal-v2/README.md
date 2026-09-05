# Leadership Coaching Portal v2 — feedback-loop experiment

Iteration on v1 after adversarial review. Same product; **different experimental
hypothesis**.

## What changed vs v1

| dimension | v1 | v2 |
|-----------|----|----|
| Requirements style | route/status-code maps (easy one-shot) | N2–N10 **outcome-only**; contract in tests |
| Role separation (O3) | coach-vs-coach only | **client → every coach surface → 403** (hard matrix on N9) |
| Opt-in sharing (O4) | dead `sharedWithClient: false` flag | **PATCH share toggle**; portal shows shared notes/feedback |
| Safe errors (O6) | untested | malformed JSON → **400**; no password echo |
| frame-checks | only N1 full file | per-node checks under `checks/` |
| Iteration budget | 6–8 | 8–10 on stress nodes (N1/N5/N6/N9/N10) |

## Success criteria for *this* experiment

1. Batch still produces trustworthy greens (strict baseline, evaluatorGuard, no test edits).
2. **At least one node uses ≥2 iterations** — evidence the feedback loop steered repair.
3. Post-run adversarial: client session cannot `POST /api/clients` (v1 gap closed).

## Result (2026-08-08)

| criterion | result |
|-----------|--------|
| 1 trustworthy green | **PASS** — 10/10, strict baseline RED, evaluatorGuard armed, 35/35 suite |
| 2 multi-iteration | **FAIL (null again)** — every node 1 iter; agent reads tests + one-shots |
| 3 O3 gap closed | **PASS** — `requireCoach` on coach surfaces; N9 hard matrix green |

**Cost/time:** ~$1.77 · 524s · 65 turns · ~461k in / 37k out tokens

**Lesson:** Underspecifying *requirements* while leaving acceptance tests readable
in `workspace.dir` still lets a strong model one-shot. To exercise
`buildFeedback`, the next design should either (a) keep graders outside the
workspace so the agent only sees failure text in feedback, (b) use a weaker
driver/model, or (c) seed a deliberately partial implementation the agent must
repair across iterations.

## Run

```bash
cd test-runs/leadership-coaching-portal-v2/app && npm install

# from loop-generator repo root
npm run loopgen -- lint test-runs/leadership-coaching-portal-v2/coaching-portal.batch.yaml
npm run loopgen -- batch test-runs/leadership-coaching-portal-v2/coaching-portal.batch.yaml \
  --report test-runs/leadership-coaching-portal-v2/batch-report.json
```

## Layout

- `app-plan.md` — frame-app DAG + obligation table  
- `checks/` — frame-checks per node  
- `loops/` — author-loop specs  
- `coaching-portal.batch.yaml` — needs DAG  
- `app/` — greenfield workspace + pre-seeded RED suite  
