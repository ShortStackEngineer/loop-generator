---
name: frame-app
description: >-
  Decompose a whole application spec into a dependency-ordered graph of RED-able
  vertical slices — the planning step above frame-checks. Cut the app into the
  smallest observable outcomes (a user can sign up, a link redirects), wire the
  edges from setup dependencies (B can't be tested until A's behavior exists),
  route cross-cutting concerns (auth, audit, quotas, notifications) and heavy
  shared engines (pipelines, scorers) as inherited obligations/infrastructure
  rather than nodes, seat one or more walking skeletons so no node is
  scaffold-only, name the invariants every later slice must preserve, and emit
  only the currently-buildable frontier — then re-plan as each slice ships and new
  requirements surface. The output is a build plan (an emergent DAG + invariants)
  that feeds frame-checks one frontier at a time and promotes verified loops into a
  batch manifest. Use when someone has a multi-feature app/product spec and wants
  to build it as a loop-of-loops, asks "how do we break this spec into loops / a
  batch," or needs a build order before authoring any .loop.yaml.
---

# frame-app

frame-checks turns **one** request into checks. author-loop turns those into
**one** verified `.loop.yaml`. batch runs **many** loops on a `needs` DAG. This
skill is the missing front: it turns a **whole app spec** into that DAG — deciding
*what the slices are and the order they become buildable* — then hands them to
frame-checks one frontier at a time.

It never writes checks itself. Its whole job is the decomposition: the nodes, the
edges, the invariants, and which slice is ready **now**. The plan↔manifest schema,
the cross-cutting routing table, a full worked app, the "how a decomposition lies"
catalog, and the downstream mapping live in `reference.md`.

**Apply the principles, don't hunt for a closed list.** The buckets, invariant
kinds, and edge types below are *recurring*, not exhaustive — every real app
surfaces a shape the enumeration didn't name. When something is observable but has
no standalone outcome, route it by the *principle* (obligation, engine, aggregation
node), and add to your plan's invariant list rather than expecting this file to have
pre-listed it.

## The one rule

**A node earns its place only if it is one observable outcome that becomes RED-able
once its prerequisites ship.** Two consequences do all the work:

- **Slice vertically, never by layer.** "The `users` table exists" is an artifact,
  not an outcome — nothing frame-checks can turn RED. "A new user signs up and then
  appears in their profile" is an outcome, RED-able end to end. A node owns its
  DB+API+UI for *one* capability; layers are not nodes.
- **Edges are setup dependencies, not import graphs.** B `needs` A iff you *cannot
  arrange B's RED check without A's behavior already existing*. "Log in" needs "sign
  up" because login's test seeds an account **through the real signup path** — which
  exists only after A ships. "The login UI imports the auth service" is not an edge;
  it lives inside one slice.

And the honest failure mode is a feature: **a piece of the spec with no observable
outcome isn't a node — it's a design gate, a cross-cutting concern, or a shared
engine. Route it, don't invent a loop for it.**

## Workflow

### 1. Restate the app as observable outcomes — then sort every fragment

Rewrite each "do X" as "X is observably true." Sort at the **scenario /
individual-behavior** level, **not** the requirement level — one requirement
routinely splits across buckets (an RBAC requirement alone can hold a node "coach
views client data," an invariant "client B → 403," and edge cases). And the inverse:
several requirements can describe **one** outcome — name it once, pull every
requirement's fragments onto that single node, don't mint a node per requirement.
Put each fragment in one of four buckets:

- **Node** — a vertical slice with one standalone observable outcome. This becomes a
  loop.
- **Artifact** — a table, config, scaffold, seed data. The *cost* of a slice, never
  a slice. When several slices can each *first-create* a shared entity (a Profile
  written by review-accept, manual-entry, or multi-profile-create), seat the artifact
  on the primary-journey creator and draw entity-reuse edges from the others — never
  duplicate it.
- **Cross-cutting concern or shared engine** — observable but with *no standalone
  outcome*. Two shapes route here: **policy** (role-based access, audit, quotas,
  notifications, environment/data isolation) → an obligation invariant (step 4); and
  a **heavy shared engine** (an LLM/ML pipeline, a scoring or rules engine, a search
  index) → it *rides as infrastructure of its first consumer slice* and is named as
  context on each later consumer. Neither is a node unless it has a standalone
  viewer/inbox/console outcome. Minting "build the judge" as a node is the
  horizontal-slice lie.
- **Design / manual gate** — genuinely subjective ("delightful onboarding"): human
  review, never a loop gate. **But** a threshold the *test harness can measure per run
  or per render* (render ≤ 5 s for 500 rows, payload size) or a *DOM-observable
  artifact* (an aria-label is present) is a **measurable axis** — keep it, hung on its
  host outcome's node. A **human-workflow timing** ("finish a plan in 30 min") and a
  **population/SLO threshold** ("70% of signups…," "≤ $30/month," "≥ 90% of runs…")
  name numbers but aren't falsifiable on a single build — they're **product/observer
  gates**, not nodes or axes.

The honest-failure clause stands: a fragment that's only a gate isn't a node — say so.

### 2. Draw the observability DAG

For each outcome ask: *what other outcome must already be observable for this one's
check to be RED for the right reason (behavior absent) — not the wrong reason (can't
even set up the test)?* Those are the `needs` edges. Cases (full table in
`reference.md`):

- B's RED check must first *do A's thing* or *create A's record through A's real
  endpoint* to have something to act on → **edge** (a plan needs a client).
- B *reuses a heavy engine that slice A was first to stand up* (the daily briefing
  reuses the judge that calibration seated) → **an ordering (engine-seating) edge** —
  mark it; it's ordering-only (B's setup doesn't call A's behavior) but re-planning
  must never schedule B before the engine exists.
- Two slices only *touch the same table* → **no edge** (they merely serialize on the
  shared workspace). A node needing **two** setup parents is normal, not a too-coarse
  smell.

Then **validate it's acyclic** — the same cycle check batch runs on a manifest. A
cycle means two slices were cut too coarsely; merge or re-cut.

### 3. Seat the walking skeleton(s)

The root has nothing to be RED against — the greenfield problem. Rule: **no
scaffold-only nodes.** A pure "stand up the server" node has no observable outcome,
so the thinnest end-to-end scaffold **rides with the first real outcome** (its RED
check is "POST /links → 404, the route doesn't exist yet").

- **An app can have more than one root.** A user-facing tier and a headless
  ingestion/data pipeline are separate skeletons — the pipeline has no actor and no
  auth. Seat each with its own first outcome; they converge at the first node that
  `needs` both (calibration needs a profile *and* opportunities). The frontier may
  legitimately start with multiple roots.
- **A heavy first feature** — auth in a full framework — is scoped to that one
  outcome's **happy path**; push siblings (login, reset, invitations) downstream so
  the skeleton doesn't become a god-node. Schema an outcome needs but doesn't exercise
  (a `role` column the coach path never sets to `client`) rides as the skeleton's
  **artifact**, as long as the node's *check* asserts only the happy path.
- **Multi-actor:** each actor's first-auth path is its own node (a coach *registers*;
  an invited tester *activates* a link) — *unless* the second actor is the **same
  identity plus an authz claim** (a `stakeholders` group, not a separate signup), in
  which case their first-auth is an *axis* of the shared signup node and their first
  *node* is their first privileged outcome.

### 4. Name the invariants — in two kinds

List the cross-feature rules every later slice must respect. They split into two
kinds that propagate differently; conflating them is how a green run ships a
regression *or* an unguarded new surface:

- **Regression guards** — behavior already shipped that must not break ("the full
  suite stays green," "a shipped slice's public contract is unchanged"). GREEN now;
  author-loop wires a suite command + `evaluatorGuard` on the prior tests into each
  downstream node. They protect *what exists*.
- **Obligation invariants** — a rule every slice must honor on its **own new
  surface**: authorization, opt-in sharing, audit, quota, environment/data isolation,
  regulatory headers, cache/version invalidation, real-time broadcast. A
  suite-stays-green guard does **not** cover these — a new endpoint the suite never
  exercises can violate the rule and stay green — so each downstream node adds a
  **fresh RED check on its own new surface**. This list is a *recurring set, not a
  closed one*: add a row whenever you find another observable-but-outcomeless rule the
  app must honor everywhere (`reference.md` has the routing table).

Keep obligations that collide *distinct*: **authorization** bars the *wrong user*;
**opt-in sharing** hides an *unshared item* from the *right user*; **data isolation**
bars *the wrong environment's rows* (harness data leaking into production) — not the
wrong user. Authorization's *positive* path (the owner *can* access) isn't a separate
check; it's each host node's happy path. Only the negatives propagate.

Name both kinds in the plan **from day one**, even when the node that first
*materializes* a concern is many frontiers away. Translate the names to the target
stack's real gates ("typecheck" ↔ `bin/rails test:all`, `go build`).

**The trap:** the two kinds are **lifecycle stages of one rule, not disjoint sets.**
A rule is an *obligation* on the frontier slice (a fresh RED check on that slice's new
surface) and, once that slice ships, *leaves behind a regression guard* protecting it
— so the same rule is an obligation ahead of the frontier and a guard behind it,
simultaneously, across the app. Two corollaries: a regression guard exists only for a
slice **already built**; and an obligation regenerates as a RED-now check only on a
slice **whose own new surface it actually touches** — a root or UI-only slice may
touch none (correct, not an omission). Mislabel the stage and you under-guard a
shipped surface or expect an unbuilt (or inapplicable) rail to pass.

### 5. Right-size the frontier

**Count by observable outcome, not by requirement**, then sanity-check the total
against *actors × capabilities*. (A rough 1–3 nodes/requirement holds only for
greenfield, *feature-shaped* requirements; in a mature **as-built** spec most
requirements are axis-level — filters, thresholds, telemetry, schema — and the same
app is far fewer nodes. Trusting a per-requirement multiplier shatters an as-built
spec into unbuildable confetti.) A CRUD cluster collapses to ~1 (create seats the
resource; read/update fold in as axes).

Two folding dimensions for *adjacent outcomes*:

- **upstream** — fold only if their `needs` and RED setup coincide (auto-suggest needs
  the survey pipeline; manual-add needs only a client → keep separate).
- **downstream** — a **lifecycle chain** (create → edit → share) has strictly
  *increasing* needs, so the upstream test never folds it — yet it's usually **one
  node with axes**. Split a verb out only when something **downstream reads the state
  that verb produces** (an archived-client portal reads "archived," so archive splits;
  a plain edit doesn't).

Folding isn't one-directional: **if one node accumulates more than ~5–6 axes,
re-check it isn't a god-node** — the tell is *axes with divergent RED setups*.
Same-setup axes fold safely (one email absorbing shortlist + threshold + suppression);
divergent-setup axes should split.

**Aggregation nodes can't ship once.** A node that gathers state from many other
nodes — a dashboard, feed, portal, or a routing endpoint like `/my-status` — has a
ballooning `needs` set yet is needed *early*. Seat its **empty shell** on the earliest
node that must reach it; let **each producer add its own "appears-here" axis**; mark
it **recurring-revisit**. Don't block the whole node on all its sources or it lands at
the end of the build while being needed at the start.

Your cuts are *hypotheses* — frame-checks falsifies them downstream: a node it can't
get RED as a single slice wasn't one.

### 6. Deliver the plan and hand off the frontier

Produce two artifacts (schemas in `reference.md`):

- **`app-plan.md`** — the *full* emergent DAG. List **all** nodes as a one-line
  outcome + `needs` + why-the-edge; only the **frontier** gets axes and a proven RED
  check. Plus the invariants (both kinds), a frontier marker, and a re-plan log that
  tracks both new requirements *and* recurring-revisit nodes (aggregation/routing
  nodes re-open as each new source ships). frame-app owns it; mutate it freely.
- **the batch manifest** — only the *verified subset*: completed + current-frontier
  nodes, each a real proven-RED `.loop.yaml`. Promote plan → manifest only after
  frame-checks + author-loop have falsified it.

Hand only the current frontier to frame-checks. When several nodes are buildable at
once but share one repo (so batch serializes them anyway), sequence by **descending
downstream fan-out** — build the biggest unblocker first. **Then re-plan** after each
frontier goes green. frame-app is a re-entrant planner, not a one-shot compiler.

## Feeding it downstream

```
app spec → frame-app → NODE{outcome, axes, needs, inherited invariants}
                        → frame-checks → check list
                        → author-loop  → verified .loop.yaml
                        → promote into  → .batch.yaml (needs + defaults)
                        → batch runner  → dependency-ordered, workspace-serialized
```

The datum frame-app must pass into frame-checks that it couldn't get alone is
**`needs` context** — "signup already works," "the judge engine exists." That's what
lets frame-checks write *seed a user via the real signup endpoint* instead of a
self-fulfilling fixture, and what tells it which obligation invariants this slice's new
surface must add a fresh check for.

Note for a **single-repo** app: batch auto-serializes same-workspace items, so the DAG
is effectively a *build order* and concurrency buys nothing until you have independent
services/repos. The `needs` graph still earns its keep — ordering and the failure
cascade.

## Guardrails

- **A layer / subsystem / engine is not a node.** "Build the API," "audit logging,"
  "build the judge" have no standalone outcome — route them as obligations or
  first-consumer infrastructure; only a standalone viewer/console is a node.
- **No scaffold-only nodes**, and **more than one root is allowed** (web tier +
  headless pipeline).
- **Count by outcome, not by requirement** — the per-requirement number lies on
  as-built specs.
- **Don't compile the forest.** *Listing* every node is fine; don't *author loops*
  past the frontier.
- **Propagate obligation invariants as fresh RED checks** on each node's own new
  surface — a regression guard can't catch an unguarded new endpoint — and treat the
  obligation set as open, not a closed list.
- **Let frame-checks falsify your cuts.** A node it can't get RED as one slice was
  mis-cut — re-slice, don't force it.
- **Name what isn't a node.** Gates (design, SLOs, human timings) go on an explicit
  list, the same honest non-answer frame-checks gives.
