# mt#3252 — cockpit tab strip: bounded working set + discoverable overflow

Acceptance Test 6 (live verification) artifacts. Captured via chrome-devtools-mcp per
`src/cockpit/CLAUDE.md` §Operator dev loop. The "after" build is this branch
(`bun run cockpit:build` + `cockpit start --port=4712`); the "before" is the tray-supervised
cockpit on `main` (port 3737), whose 49-tab strip is the operator's real state, not a fixture.

| File                               | Build                  | Shows                                                                        |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `tabstrip-before-49-tabs.png`      | `main`, port 3737      | 49 tabs, 9 visible, no indicator, no scrollbar                               |
| `tabstrip-after-bounded.png`       | this branch, port 4712 | the same 49-tab payload loaded bounded to 12, `+3` badge, active tab in view |
| `tabstrip-after-overflow-menu.png` | this branch, port 4712 | the overflow menu listing every open tab, with Close all / Close others      |

## Measurements

Both builds at a 1360px CSS viewport. The "after" run was seeded with the **old persisted shape**
(no `lastActiveAt`) so the migration path is what got exercised.

|                                       | before (`main`)   | after (this branch)                                  |
| ------------------------------------- | ----------------- | ---------------------------------------------------- |
| Tabs rendered                         | **49**            | **12** (`MAX_OPEN_TABS`)                             |
| Tabs persisted                        | 49                | 12                                                   |
| Strip scrollWidth / clientWidth       | 7303 / 1360       | 1548 / 1072                                          |
| Tabs visible at once                  | 9                 | 9                                                    |
| Tabs out of view                      | **40**            | 3                                                    |
| Hidden count reported to the operator | **none**          | `Open entities: 12 open, 3 out of view` (`+3` badge) |
| Reach an off-screen tab               | **no affordance** | overflow menu lists all 12, each a link              |
| Bulk close                            | **none**          | Close all / Close others                             |
| Active tab in view after deep link    | —                 | **yes**                                              |

Kept range after the load-time trim: `mt#3037 … mt#3048` — the newest 12 of the 49 by persisted
order, which is the only recency proxy a legacy payload carries.

### LRU eviction (live)

Navigating to a 13th entity (`/tasks/mt%232500`) with a full set:

```
tabCount:        12        (unchanged — the cap holds)
newTabPresent:   true
coldestEvicted:  true      (mt#3037, the least-recently-active, is gone)
firstKept:       /tasks/mt%233038
activeInView:    true
persisted:       12
```

### Close all (live)

```
stripPresent: false
persisted:    []
landedOn:     /
```

## One defect this pass caught

The first build scrolled the active tab into view on activation and measured `activeInView: false`
anyway. Cause: tab labels resolve asynchronously (mt#2883), so every tab widens shortly after mount
and pushes the active tab back out — a window a single on-activation scroll cannot cover. Fixed by
re-scrolling from the `ResizeObserver` callback, which fires on layout changes but never on
scrolling, so it does not fight an operator deliberately scrolling away. Re-measured: `true`.

## Reproducing

```bash
bun run cockpit:build
bun src/cli.ts cockpit start --port=4712
# then in the dev canary, on http://127.0.0.1:4712 :
#   localStorage.setItem('cockpit.tabs.v1', JSON.stringify(<49 tabs, no lastActiveAt>))
#   navigate to /tasks/mt%233048
#   document.querySelectorAll('nav[aria-label="Open entities"] [data-tab-path]').length  // expect 12
```
