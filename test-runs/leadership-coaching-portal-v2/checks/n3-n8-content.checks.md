# frame-checks — N3–N8 content slices

Each content node shares the same obligation pattern on its **own new surface**:

| node | happy path | O2 other-coach | O3 client→coach 403 | extra |
|------|------------|----------------|---------------------|-------|
| N3 360 | PUT/GET survey | yes | yes (soft→hard) | |
| N4 focus | PUT/GET areas | — | yes | |
| N5 notes | POST list; default private | — | yes | **PATCH share toggle** |
| N6 feedback | POST list; default private | — | yes | **PATCH share toggle** |
| N7 plan | PUT/GET goals+actions | — | yes | |
| N8 recs | POST book/podcast; bad type 400 | — | yes | |

N5/N6 are the **feedback-loop stress nodes**: share toggle is easy to miss on a
first pass when requirements only say “notes exist and are private by default.”
