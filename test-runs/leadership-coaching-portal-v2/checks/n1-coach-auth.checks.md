# frame-checks — N1 Coach auth + safe errors

**Outcome:** A coach can register, log in, and call `/api/me`. Errors are safe.

| # | claim | kind | evidence | RED now? | anti-gaming | check |
|---|-------|------|----------|----------|-------------|-------|
| 1 | register creates coach 201, no password leak | driver | det | routes absent | assert via HTTP | `test:n1` |
| 2 | login session + me | driver | det | absent | real cookie path | same |
| 3 | login email case-insensitive | driver | det | absent / naive exact match | different casing than register | same |
| 4 | me without session → 401 | driver | det | 404 until route | pin 401 | same |
| 5 | duplicate email case-insensitive → 409 | driver | det | absent | `DUP@` vs `dup@` | same |
| 6 | wrong password → 401, no echo | driver | det | absent | body must not contain password | same |
| 7 | malformed JSON → 400 not 500 | driver | det | Express default 500 | truncated body | same |
| 8 | typecheck clean | guard after scaffold | det | stub ok | — | `typecheck` |

**Coverage:** coach session + O6 safe errors. O3 role-sep N/A until client role exists.
