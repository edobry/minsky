# mt#4557 — reviewer-cost page, render-path evidence (AT5)

Rendered evidence for AT5: "A screenshot of the finished page at a realistic viewport is
attached to the PR, uncropped." This is presented for the principal to judge; nothing here
asserts the page looks right — only that it renders the state the code actually produces.

## How this was produced

|          |                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build    | Vite dev server (`bun src/cli.ts cockpit start --dev --port=4557`), HMR-live                                                                                                                                                                         |
| Driver   | Raw CDP (`fetch` + `WebSocket`, no new dependency) against the session's own dev chromium at `127.0.0.1:9222` — chrome-devtools-mcp in this environment is configured for a port with nothing listening (connection refused), so it could not attach |
| Viewport | 1440x900                                                                                                                                                                                                                                             |
| Route    | `/reviewer/cost`                                                                                                                                                                                                                                     |
| Commit   | `809644510` (Dockerfile fix; no frontend change since the R2 fix below)                                                                                                                                                                              |

## The file

- **`reviewer-cost-not-yet-available.png`** — the page's current, real render: the neutral "Not
  yet available" notice (see `ReviewerCostPage.tsx`), reserved for the KNOWN "mt#4546's
  `review_timing` accessor isn't wired yet" case. This is genuinely what the page shows today —
  neither of the two operator asks (chart library, mt#4546 ownership) has resolved, so there is
  no live data to render yet.

## Why this file replaces an earlier, wrong attachment

The first version of this PR referenced `/tmp/reviewer-cost-screenshot.png` by path in the body
— an out-of-repo path nobody but the authoring session could open. The reviewer correctly marked
AT5 **Unverifiable** for that reason. Separately, and worse: that referenced file was captured at
18:10Z, **before** the R1 review-fix landed (~18:23Z), so it showed the urgent red "Data
unavailable" error banner — the exact always-erroring appearance the reviewer's R1 BLOCKING
finding was about. The one piece of "render-path evidence" on the PR was a picture of the bug,
not of the fix.

Four captures exist across this PR's history, with distinct md5 sums proving each is a genuinely
different capture, not a stale reuse:

```
6a663ed692ef4ddee1ccfda4973cf609  reviewer-cost-screenshot.png     (18:10Z, pre-R1: red "Data unavailable" error banner)
fef89c72971a30f9a52ae179eb97ac36  reviewer-cost-screenshot-v2.png  (18:21Z, R1-fixed but crashed at runtime: "process is not defined")
d218f05188033522b17ef99f11b6dfc7  reviewer-cost-screenshot-v3.png  (18:23Z, post-R2 fix: neutral "Not yet available" notice)
a7427c4a9c307c6c3c13b0ad7a6611ec  reviewer-cost-not-yet-available.png  (18:38Z, re-captured against current HEAD; this file)
```

The last two are the same rendered state, captured ~15 minutes apart against an unchanged
frontend (only `services/cockpit/Dockerfile` changed between them) — re-verified rather than
assumed identical.

## Known limitation of this capture method

Content-readiness was polled against a fixed set of `data-testid` selectors written before the
R1/R2 fixes introduced a new one (`reviewer-cost-not-yet-available`); the poll timed out at 15s
on this capture even though the page had in fact finished rendering well before that. The
screenshot itself is still valid — `Page.captureScreenshot` was called after the timeout, by
which point the page was settled — but the "content ready: true" self-check this script reports
should not be trusted for this specific render without independently confirming the DOM, which
was done by visually inspecting the saved PNG.
