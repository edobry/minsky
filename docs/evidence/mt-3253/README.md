# mt#3253 — ask option labels: lint the label, normalize the prefix at display

Live verification artifacts, captured via chrome-devtools-mcp against a cockpit built from this
branch (`bun run cockpit:build` + `cockpit start --port=4713`) reading the **real ask corpus** — not
fixtures. Per `src/cockpit/CLAUDE.md` §Operator dev loop.

| File                           | Shows                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| `asks-inbox-normalized.png`    | `/asks` — the mt#2505 rows' `[a]`/`[b]`/`[c]` markers gone from the buttons |
| `ask-detail-single-letter.png` | `/ask/f90fc0af…` — the lettered option list rendering ONE letter            |

## The corpus this is grounded in (measured 2026-07-26)

200 options across the 67 asks that populate `options[]` (6185 asks total):

| Statistic                              | Value                                           |
| -------------------------------------- | ----------------------------------------------- |
| Label length p50 / p75 / **p90** / max | 36 / 48 / **62** / **167**                      |
| Labels > 60 chars (the budget)         | 23 (11.5%)                                      |
| …of those, with an EMPTY `description` | 14                                              |
| Labels with a redundant letter marker  | **35 (17.5%)** — 27 separator-form, 8 bracketed |

The 60-char budget is the corpus p90, so the check fires on the tail rather than on typical labels.
The 45-char alternative (where the inbox's `max-w-[22rem]` starts truncating) would fire on 63 of
200 — too noisy for a warn-only lint.

Worst observed label, 167 chars, a paragraph inside a button — and letter-prefixed as well:

```
B — boundary fix + Stop-event ADVISORY guard (recommended): agent self-addresses admissions at
turn end; dedup vs prompt-time scanner; first Stop dispatcher entrypoint
```

## Live results

Read off the running cockpit against live data:

```
asks in the inbox whose PERSISTED labels carry a marker:  2
persisted labels (unchanged — no migration):
    "[a] GitHub Actions migrate-on-merge (recommended)"
    "[b] Railway pre-deploy/release command"
    "[c] Supabase CLI migration deploy"
rendered buttons carrying a marker:                       0
```

Detail page (`/ask/f90fc0af-bab8-470e-9d89-2346c1e07ac5`, the ask whose labels carry `[a]`/`[b]`/`[c]`):

```
option list rows:   "A)GitHub Actions migrate-on-merge (recommended) — Supabase-canonical; …"
                    "B)Railway pre-deploy/release command — Heroku-release-phase analog; …"
                    "C)Supabase CLI migration deploy — Native Supabase tooling but …"
resolve buttons:    "A) GitHub Actions migrate-on-merge (recommended)"
                    "B) Railway pre-deploy/release command"
                    "C) Supabase CLI migration deploy"
doubled letter anywhere on the page:  false
```

Before this change those read `A) [a] GitHub Actions migrate-on-merge (recommended)`.

Two things deliberately NOT touched, both visible in the artifacts:

- **The persisted labels.** 6185 asks are already stored; normalization is at render.
- **The question BODY.** `ask#3346`'s question contains `[a] GitHub Actions job on merge-to-main — …`
  as prose (visible in the detail screenshot). That is the author's own text, not an option label,
  and rewriting it would be wrong.

## Browser-safety check (mt#3239 lesson)

The new module is imported by cockpit web, so it must carry no Node dependency. It has zero imports
by construction — verified empirically against the built bundle rather than assumed:

```
$ grep -c 'process' src/cockpit/web/dist/assets/AskPage-*.js   -> 0
$ grep -c 'process' src/cockpit/web/dist/assets/AsksPage-*.js  -> 0
```

## Reproducing

```bash
bun run cockpit:build
bun src/cli.ts cockpit start --port=4713
# then in the dev canary on http://127.0.0.1:4713/asks :
#   [...document.querySelectorAll('.max-w-5xl button')].map(b => b.textContent.trim())
#     .filter(t => /^(\[[a-z]\]|[A-Z]\s*[-—–:])/.test(t))   // expect []
```
