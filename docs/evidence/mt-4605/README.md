# mt#4605 — render-path evidence

The fixed `/protection` banner, rendered against the LIVE corpus — not a fixture. This is
presented for the principal to judge; nothing here asserts the page looks right.

## How this was produced

|          |                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | `bunx vite --config vite.config.ts --port 4605` from the session workspace (this branch)                                                                         |
| Data     | Vite's `/api` proxy to the already-running cockpit backend on `localhost:3737` — real production aggregates, no fixture                                          |
| Driver   | chrome-devtools MCP against a throwaway headless Chrome (its own `--user-data-dir` under the session scratchpad; the principal's browser untouched, then killed) |
| Viewport | 1280x900, full-page capture                                                                                                                                      |
| Route    | `/protection`                                                                                                                                                    |
| When     | 2026-08-25 ~23:09Z                                                                                                                                               |

## The file

- **`protection-never-verified.png`** — the page as it renders today: one amber block reading
  **"81 checks of 149 have never been verified — nothing has ever tested that they fire, and
  refreshing won't change that."**, and per-class lines carrying that class's own count.

Before this change the same state rendered "Can't confirm the checks are working — that history
wasn't available on the last refresh", which was false: `sourceFailures` was empty and nothing
had failed to load. The live snapshot behind this capture carries 81 `never-verified`, 68
`passing`, 0 `broken`, `sourceFailures: []`.

## One rendering call worth flagging

The per-class "N checks here have never been verified" line is rendered **muted, not amber**.
Amber is reserved for a LIVE problem — a read that failed just now. Rendered amber, this line
lands on 8 of the 11 class rows (visible in the capture), which turns the page's alarm colour
into its background texture and re-creates the all-green-grid failure the surface's own design
notes call out, from the other direction. The corpus banner states the ratio once, loudly.
