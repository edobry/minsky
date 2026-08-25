# mt#4599 — lifecycle spine layout, render evidence (AT6)

Uncropped renders of `/interceptors`, before and after. Presented for the principal to judge;
nothing here asserts the result looks right — only that it renders the state the code produces.

## How these were produced

|        |                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Driver | Python Playwright, headless Chromium, `device_scale_factor=2`, `color_scheme="dark"`                                          |
| Wait   | `wait_until="domcontentloaded"` + 6s settle — the page holds a live stream, so `networkidle` never fires and times out at 60s |
| Before | the running main-workspace cockpit on `127.0.0.1:3737` (un-fixed tree)                                                        |
| After  | a session-workspace dev cockpit on `127.0.0.1:4599` (`bun src/cli.ts cockpit start --dev --port=4599`)                        |
| Data   | identical — the same live 148-entry catalog in both                                                                           |

## The files

| File                            | What it shows                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-page-1280.png`          | The whole page at 1280px, un-fixed. The band is cut at the container edge mid-card ("subagent s…"); 7 of the 12 stations are off-screen behind a horizontal scroll with no affordance.                    |
| `before-spine-560-scrolled.png` | The band at 560px scrolled to its right end, un-fixed — the principal's reported view. `merge` holds 9 dots at the top of a 192px box; `CI` and `review` are near-empty boxes of the same imposed height. |
| `after-page-1280.png`           | The whole page at 1280px, fixed. All twelve stations visible across three wrapped rows, no scrollbar, each card at its own height.                                                                        |
| `after-spine-560.png`           | The band at 560px, fixed. Four wrapped rows, nothing clipped, nothing scrolled.                                                                                                                           |

## What the before/after pair does NOT establish

Both renders come from headless Chromium. The principal reads this page in the cockpit-tray
WKWebView and in a browser; flex-wrap and `items-start` are not engine-sensitive features, but
this evidence is Chromium's, and the tray render has not been exercised.
