# frame-checks — N9 Portal access + hard O3

| # | claim | kind | notes |
|---|-------|------|-------|
| 1 | coach grants portal access; client `/api/portal/me` | driver | |
| 2 | coach cannot use portal/me | driver | |
| 3 | **client cookie → every coach surface → 403** | driver O3 | full surface matrix — closes v1 gap |
| 4 | two clients get distinct portal identities | driver O5 | |

This is where role-separation is **non-optional**. Soft skips from N2–N8 become
hard failures if still open.
