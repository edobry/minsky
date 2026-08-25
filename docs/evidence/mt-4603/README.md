# mt#4603 — interception-point facet, render evidence (AT1)

The `/interceptors` interception-point dropdown, open, before and after. Presented for the
principal to judge; nothing here asserts the result looks right — only that it renders the state
the code produces.

## How these were produced

|        |                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Driver | Python Playwright, headless Chromium, `device_scale_factor=2`, `color_scheme="dark"`                     |
| Wait   | `wait_until="domcontentloaded"` + 7s settle — the page holds a live stream, so `networkidle` never fires |
| Before | the main-workspace cockpit on `127.0.0.1:3737` (un-fixed)                                                |
| After  | a session-workspace dev cockpit on `127.0.0.1:4603`                                                      |
| Data   | identical — the same live 148-entry catalog on both                                                      |

## The files

| File                     | What it shows                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-point-facet.png` | Ten options: `Any interception point` plus the spine's nine. `SessionStart`, `StopFailure`, `Notification`, `PermissionRequest`, `PreCompact` and `PostCompact` are absent, so the two live entries at `SessionStart` and `PostCompact` cannot be filtered to. |
| `after-point-facet.png`  | Sixteen options: `Any` plus all fifteen union members.                                                                                                                                                                                                         |

## A note on how the "before" capture was taken

The capture script anchors on an option being visible before screenshotting. Anchoring the
un-fixed run on `PostCompact` timed out after 15s — which is the defect itself, not a script
fault: that option does not exist there. The before shot is anchored on `merge-time` instead. The
timeout is itself a negative confirmation and is worth reading as one.
