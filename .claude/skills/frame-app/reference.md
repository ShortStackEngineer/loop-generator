# frame-app — reference

Depth behind `SKILL.md`: the two artifacts and their schemas, the cross-cutting +
shared-engine routing, patterns for bigger apps, a worked app, the edge taxonomy, the
"how a decomposition lies" catalog, and the downstream mapping.

The buckets, edge types, and invariant rows here are a **recurring set, not an
exhaustive one**. Every real app surfaces a shape the list didn't name; apply the
principle and extend your plan, don't wait for this file to have pre-listed it.

## The two artifacts

frame-app keeps the *emergent* DAG separate from the *runnable* manifest. batch
requires every item to have a real, lintable `spec`/`inline`, so un-authored future
nodes **cannot** live in a manifest. They live in the plan until they're verified.

### `app-plan.md` — frame-app owns it

```markdown
# <app> — build plan

## Invariants (every promoted node inherits these; the list is a recurring set — extend it)
Regression guards — protect what's shipped (author-loop: suite command + evaluatorGuard on prior tests):
- the full test suite stays green
- a shipped slice's public contract is unchanged
Obligation invariants — every slice proves on its OWN new surface (author-loop: a fresh RED check per node):
- authorization: a client sees only their own data (403 on cross-account access)
- opt-in sharing: nothing is client-visible unless explicitly shared
- audit: every sensitive action writes an immutable log record
- data isolation: every production read filters out other-environment rows (e.g. WHERE scenario_run_id IS NULL)
- quota / cost caps, regulatory email headers, cache/version invalidation … (add per app)

## Nodes (all listed one-line; only the frontier gets axes + a RED proof)
| id  | outcome (observable)                      | needs   | why the edge (setup dependency)           | status   |
|-----|-------------------------------------------|---------|-------------------------------------------|----------|
| N1  | POST a URL returns a working short code   | —       | root; carries the skeleton                | shipped  |
| N2  | GET /{code} redirects to the original URL | N1      | test must create a link via N1 first      | frontier |
| N3  | GET /{unknown} returns 404                | N2      | 404 is defined against N2's route         | planned  |  ← may fold into N2
| N4  | each redirect increments a hit counter    | N1, N2  | create (N1) then redirect (N2) to observe | planned  |

## Frontier: { N2 }  (may hold multiple roots)

## Re-plan log (new requirements AND recurring-revisit nodes)
- after N1: codes must be URL-safe & collision-checked → axis on N1 (done)
- recurring: the /status routing node re-opens whenever a new state producer ships
```

### the batch manifest — author-loop populates it

Only the **verified subset**: shipped + frontier nodes. `needs` edges copy straight
from the plan; both invariant kinds ride *inside* each node's evaluators (author-loop
wires them: regression guards as a suite command + `evaluatorGuard` on prior tests;
obligation invariants as a fresh RED check on the node's own new surface), **not** in
batch `defaults` — which only merges `base`/`maxIterations`/`baseline`/`skipPreflight`.

```yaml
version: 1
name: link-shortener
concurrency: 1            # single repo → same-workspace serialization makes this moot
continueOnError: false    # a failed slice blocks its dependents (the cascade)
defaults: { base: ./app, baseline: strict }
items:
  - { name: N1-create, spec: loops/n1-create.loop.yaml }
  - { name: N2-redirect, spec: loops/n2-redirect.loop.yaml, needs: [N1-create] }
# N3, N4 stay `planned` in app-plan.md until authored
```

## Cross-cutting concerns and shared engines — the fourth bucket

Two shapes have no standalone outcome and so are neither nodes, artifacts, nor gates.

**Policy** (auth, audit, notifications, quotas, data isolation) → an **obligation
invariant**. Route each with one test:

- **Standalone viewer/inbox/console outcome?** (a notifications inbox, an audit-log
  viewer, an operator dashboard panel) → *that page* is a node; the *emission* behind
  it is not.
- **Otherwise it rides.** Seat its infra as an *axis of the first host slice*, require
  it as an axis on every later host slice, and name it an obligation invariant.

| concern | first materialized as | later slices carry | node? |
|---|---|---|---|
| authorization | a 403 axis on the first surface a *non-owner actor can reach* | a fresh 403/scoping check per new surface | no |
| audit emission | an axis on the first sensitive action | an axis per audited action | only the *viewer* |
| notifications | an axis on the first event that notifies | an axis per new event kind | only the *inbox* |
| quota / cost cap | an axis on the first spend/upload path | an axis per such path (aggregate caps need a cross-path check) | only the *usage view* |
| data isolation | an axis on the first production read path | a fresh leakage check per new read path | no |
| real-time / regulatory header / cache-version | an axis on the first surface that emits it | an axis per new emitter | rarely |

**Every row above is an obligation invariant — but this is a *recurring set, not a
closed one*.** SKILL.md's step-4 list and this table are both illustrative; **add a
row whenever you find another observable-but-outcomeless rule** the app must honor
everywhere. Missing one is how invariant amnesia ships an unguarded surface.

Keep colliding obligations MECE: **authorization** bars the *wrong user*; **opt-in
sharing** hides an *unshared item* from the *right user*; **data isolation** bars *the
wrong environment's rows* (harness data leaking to production) — not the wrong user.
An obligation enforced by a *named contract test* (e.g. `test_harness_run_does_not_leak`)
is both kinds at different stages: it *guards* the readers it already covers, and every
*new* read path must add its own fresh leakage check. Authorization's *positive* path
(owner can access) isn't a row here — it's each host node's happy path.

**Heavy shared engine** (an LLM/ML pipeline, a scoring or rules engine, a search
index) → **infrastructure of its first consumer**, not policy. It has no standalone
outcome, so it isn't a node; it *rides* the first slice whose outcome needs it (the
enrichment pipeline rides the first onboarding slice that produces a profile; the judge
rides the first ranking slice) and is named as context on each later consumer. Later
consumers draw an **engine-seating edge** to the slice that stood the engine up (below).
Minting "build the judge" as a node is the horizontal-slice lie.

## Patterns for bigger apps

Three shapes the link-shortener is too small to show; each recurred across very
different specs (a CRUD app and an async-pipeline SaaS).

- **Multiple roots.** A user-facing tier (rooted at signup) and a headless
  ingestion/data pipeline (rooted at "ingest a feed → rows persisted," no actor, no
  auth) are *separate skeletons*. Seat each; the frontier starts with both; they
  converge at the first node that `needs` both (a briefing needs a profile *and*
  opportunities).
- **Shared engine + seating edge.** The engine rides its first consumer (calibration
  seats the judge). Every *later* consumer (the daily briefing) draws an ordering
  **engine-seating edge** to that first consumer — even though its RED setup never
  calls the first consumer's behavior — so re-planning never schedules a consumer
  before the engine exists.
- **Aggregation / recurring-revisit node.** A dashboard, feed, portal, or routing
  endpoint (`/my-status`) gathers state from many nodes: its `needs` balloons yet it's
  needed *early*. Seat the **empty shell** on the earliest node that must reach it; let
  **each producer add its own "appears-here" axis**; mark it **recurring-revisit** in
  the re-plan log. Do not ship it once, and do not block it on all its sources.

## Worked app — link-shortener API

**Spec:** "POST a long URL → short link; visiting it redirects; track hit counts."

**1. Outcomes:** create · redirect · reject unknown · count hits. Not outcomes: "a
links table," "a Redis cache," "clean routing."

**2. DAG:** N2 needs N1 (its RED check creates a link via N1's real endpoint); N3 needs
N2 (404 is defined against the route); N4 needs N1+N2 (create then redirect to observe).
Acyclic ✓; N1 is the root and carries the skeleton.

**3. Skeleton (rides N1):** server + storage + one route is the cost of N1's outcome,
not a node. RED: `POST /links` → connection refused / 404.

**4. Invariants:** regression — suite green, N1's POST contract frozen once shipped.
Obligation — few here (no auth); if links were per-user, "a user's code can't be
resolved by another" is an obligation each later slice re-checks on its own surface.

**5. Right-size:** N3 shares N2's `needs` and setup → fold as an **axis of N2**. N4
stays separate (distinct outcome, its own RED check).

## The edge taxonomy — observability edge vs import edge

The most common error is drawing edges from the code graph, not the test-setup graph.

| looks like a dependency | is it a `needs` edge? |
|---|---|
| B's module `import`s A, or B's UI calls A's API in the same feature | **No** — internal wiring / one slice |
| B's RED test must first *do A's thing* to have something to act on | **Yes** |
| B's RED check must first *create A's record through A's real endpoint* to attach to | **Yes** (a plan needs a client) |
| B *reuses a heavy engine A was first to stand up* (briefing reuses calibration's judge) | **Yes — an ordering (engine-seating) edge**; ordering-only, but re-plan must not schedule B before the engine exists |
| B needs **two** real setup parents (an upload needs a client *and* a template) | **Yes to both** — multi-parent is normal, not a too-coarse smell; only a *cycle* is |
| B and A only *touch the same table* — neither needs the other's behavior | **No** — they merely serialize on the shared workspace |

The test: *write B's RED check in your head — does its arrange-step call A's behavior,
create A's record, or reuse an engine A stood up?* If none, no edge.

## How a decomposition lies — catalog

| the lie | what it looks like | the counter |
|---|---|---|
| **horizontal slice** | a node is a layer ("build the API") | re-cut as a vertical slice with an observable end-to-end result |
| **horizontal engine** | "build the judge / the pipeline" as a node | a shared engine has no standalone outcome — it rides its first consumer + an engine-seating edge from later ones |
| **subsystem-shaped feature** | "Audit Logging" / "Notifications" made a node | emission is an axis + obligation invariant; only a standalone viewer/inbox/console is a node |
| **god-node** | one slice too broad to converge — *tell: axes with divergent RED setups* | split by outcome; same-setup axes fold safely, divergent-setup axes split |
| **aggregation shipped once** | a dashboard/portal/`/my-status` blocked on all its sources | seat the empty shell early, one "appears-here" axis per producer, mark recurring-revisit |
| **phantom edge** | `needs` drawn from the import graph | keep only setup/create/engine-seating edges; drop the rest |
| **obligation laundered as a regression guard** | authz/audit/isolation carried as "the suite stays green" | a new endpoint the suite never exercises violates it unseen — each slice adds a fresh RED obligation check on its own surface |
| **closed-list invariants** | only guarding the rows this file lists | the set is recurring — name every app-specific observable-but-outcomeless rule on day one |
| **SLO smuggled as an axis** | "70% of signups…", "≤ $30/mo" treated as a per-build check | a population/SLO threshold is a product/observer gate, not a node or axis; only per-run/per-render thresholds are axes |
| **per-requirement sharding** | ~1 node per requirement on an as-built spec | count by observable outcome; sanity-check against actors × capabilities |
| **premature full-compile** | author all nodes up front | *list* all nodes as one-liners; *author* only the frontier |

The through-line: **a node is good when the only way to turn it green is to build one
real, observable capability — and it can't even be tested until its prerequisites
exist.**

## → downstream mapping

| frame-app | consumed by |
|---|---|
| a node `{outcome, axes, needs, invariants}` | **frame-checks** — one request → a check list, using `needs` to write real setup |
| a `needs` edge (incl. engine-seating) | a `.batch.yaml` `items[].needs` (copied verbatim) |
| acyclic-DAG check | batch's own `validateBatchManifest` cycle detection |
| Invariants — **regression guards** | a suite command + `evaluatorGuard` on prior tests, per node |
| Invariants — **obligation invariants** | a *fresh RED check on each node's own new surface* |
| shared workspace / base | `defaults.base`; batch auto-serializes same-workspace items |
| frontier node(s) | the only thing handed to frame-checks now; the rest waits in the plan |
| a design/SLO/manual gate | *not* a node — human review / observer metric, outside every loop |

Hand each frontier node to **frame-checks**, then its check list to **author-loop**,
which proves it lint-clean and starts-RED against the real (now-grown) repo before any
agent budget is spent. frame-app's job ends at "here is the DAG and the ready
frontier"; the RED-first proof is done per node, downstream, where the repo exists.
