# mt#3246 — /asks row layout: visual evidence

Acceptance Test 2 artifacts for task mt#3246 (PR #2333). Screenshots are viewport captures
of `/asks` driven via chrome-devtools-mcp against a cockpit built from this branch
(`bun run cockpit:build` + `minsky cockpit start --port=4711`), per
`src/cockpit/CLAUDE.md` §Operator dev loop. The "before" capture is the same page served by the
tray-supervised cockpit on the pre-fix `main` build, taken in the same session.

| File                   | Build                       | Viewport (CSS px) |
| ---------------------- | --------------------------- | ----------------- |
| `asks-before-1440.png` | pre-fix (`main`, port 3737) | 1440              |
| `asks-after-1280.png`  | this branch (port 4711)     | 1280              |
| `asks-after-1440.png`  | this branch (port 4711)     | 1440              |
| `asks-after-1920.png`  | this branch (port 4711)     | 1920              |

## Measurements

Evaluated in-page against the ask-list container (`.max-w-5xl`). `overflowPx` is
`scrollWidth - clientWidth` — Success Criterion 1 requires 0. `childCollisions` counts
overlapping rect pairs between the title button's own child spans (priority badge, `ask#N`, title)
and the sibling metadata cells (requestor, standing, deadline, age) — Success Criterion 2 requires 0. The child-level comparison is the correct one: pre-fix the title button itself collapsed to
`width: 0`, so a button-rect comparison reports no collision while its children visibly paint over
the metadata.

### Pre-fix (port 3737, 1440px)

```
overflowPx: 984            (scrollWidth 2008 vs clientWidth 1024)
row 1  titleBtnW   0  collisions: ask#3346|plan-task agen, mt#2505: which|plan-task agen
row 2  titleBtnW   0  collisions: ask#3398|plan-task agen, mt#2505: which|plan-task agen
row 3  titleBtnW   0  collisions: P3|agent:minsky:d, ask#5106|agent:minsky:d, Adopt the June|agent:minsky:d
row 4  titleBtnW   0  collisions: P3|calibration-re, ask#6136|calibration-re, Calibration re|calibration-re
row 5  titleBtnW 408  collisions: none
```

Nine colliding pairs across four of five rows; 984px of horizontal overflow, which is what put
`Defer` and the open-detail button outside the viewport.

### This branch (port 4711)

| Viewport | container overflowPx | document overflow | rows with collisions | title button widths | every `Defer` inside viewport |
| -------- | -------------------- | ----------------- | -------------------- | ------------------- | ----------------------------- |
| 853      | 0                    | 0                 | 0 / 5                | 230–313             | yes                           |
| 960      | 0                    | 0                 | 0 / 5                | 336–420             | yes                           |
| 1280     | 0                    | 0                 | 0 / 5                | 640–724             | yes                           |
| 1440     | 0                    | 0                 | 0 / 5                | 640–724             | yes                           |
| 1920     | 0                    | 0                 | 0 / 5                | 640–724             | yes                           |

The widest descendant of the container sits 16px inside its right edge (the container's own padding)
at every width — nothing escapes.

Row heights at 1920px: **72px** for the row whose action set fits on the consequence line
(`ask#6164`, Approve/Deny/Defer — the density-preserving case, Success Criterion 5), **92px** and
**120px** for rows whose longer option sets wrap into one or two extra action lines. The expanded row
renders its action bar below the question and the lettered options (`actionsAfterQuestion: true`).

## Reproducing

```bash
bun run cockpit:build
bun src/cli.ts cockpit start --port=4711     # keep the :9222 dev canary
# then, in the canary via chrome-devtools-mcp, on http://127.0.0.1:4711/asks:
#   container = document.querySelector('.max-w-5xl')
#   container.scrollWidth - container.clientWidth        // expect 0
```
