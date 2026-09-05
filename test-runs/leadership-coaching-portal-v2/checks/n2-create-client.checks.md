# frame-checks — N2 Create client

**needs:** N1 (real coach session)

| # | claim | kind | RED | notes |
|---|-------|------|-----|-------|
| 1 | coach creates client; list + get by id | driver | yes | happy path |
| 2 | unauth create → 401 | driver (O1) | yes | |
| 3 | coach B cannot list/get A's client | driver (O2) | yes | |
| 4 | client session → create/list → 403 | driver (O3) | soft until portal; hard in N9/N10 | |

Requirements for this node are **outcome-only** — agent must discover
routes/status codes from failing tests / feedback.
