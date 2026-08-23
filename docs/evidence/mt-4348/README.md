# mt#4348 — one disclosure system, and a fold that shows its nesting

Rendered evidence for the acceptance criterion requiring rest/expanded screenshots.
Aesthetic acceptance is the principal's; nothing here asserts the result looks right.

## How these were produced

PROD bundle (`bun run cockpit:build`), served by `bun src/cli.ts cockpit start --port=3940`,
health asserted `service: minsky-cockpit`. Driven over chrome-devtools-mcp on the shared dev
canary at 1440x900, against the **settled** transcript `agent-a40881c8b15f70597` (`endedAt`
non-null — a live conversation re-renders under the capture, which is how mt#4251 produced a
hovered screenshot byte-identical to its resting one; see mem#1148).

- **`fold-collapsed.png`** — the action-burst fold closed.
- **`fold-expanded.png`** — the same fold open. This is the image the task is about: the
  revealed turns sit behind a hairline rail, indented from the fold's own summary line, so it
  is visible which fold they belong to.

Distinct captures, not the same frame twice:

```
b44ac3119c2c769055a9a0db0d33313f  fold-expanded.png
001ff1724c8b83534fbcafa27f5c5094  fold-collapsed.png
```

## Measured in the same session

The structural claims, read from the live DOM rather than asserted from the diff:

```
summaryDisplay:      "flex"        summaryListStyle: "none"     // native <summary> marker suppressed
chevronCount:        30
distinctChevronX:    [425, 438]                                 // TWO columns = two depths
childrenBorderLeft:  "1px"                                      // the fold's rail
```

`distinctChevronX` is the whole point in one number. Thirty disclosure markers across the
viewport resolve to exactly two x positions — depth 0 and depth 1, 13px apart (`pl-3`). Before
this change the same view drew markers from three mechanisms at two positions that encoded
nothing: `BurstFold` leading, `ThinkingBlock` inheriting the browser's native `<summary>`
triangle, and the tool row / injected span / command each pinned right with `ml-auto`.

Note happy-dom has no layout engine, so this alignment cannot be asserted in the component
suite (`src/cockpit/CLAUDE.md` §"Asserting layout geometry"). The suite pins the DOM shape that
produces it — one chevron per control, leading, no `ml-auto` between glyph and control — and
this measurement covers the geometry.
