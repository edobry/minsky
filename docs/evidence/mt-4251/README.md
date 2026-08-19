# mt#4251 — hover affordance on the conversation view's disclosure controls

Rendered evidence for the acceptance criterion "a screenshot at a realistic viewport showing
rest and hover states is attached for the principal to judge." Aesthetic acceptance is the
principal's; nothing here asserts the result looks right.

## How these were produced

|          |                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle   | `bun run cockpit:build` (PROD bundle, not Vite HMR — `src/cockpit/CLAUDE.md` §"Visual verification")                                                     |
| Server   | `bun src/cli.ts cockpit start --port=3939`, health asserted `service: minsky-cockpit`, `db: ok`                                                          |
| Driver   | chrome-devtools-mcp on the shared dev canary (`--remote-debugging-port=9222`)                                                                            |
| Viewport | 1440x900                                                                                                                                                 |
| Specimen | `/conversation/agent-a40881c8b15f70597` — a SETTLED transcript (`endedAt` non-null) carrying prose, one tool row, one folded run, and a thinking summary |

## The files

- **`rest.png`** — nothing hovered. The at-rest appearance mt#4220 established and this task
  must not change: no border, no tint, no accent hue on the healthy path.
- **`hover-tool-row.png`** — pointer over the `Bash curl -sL …` tool row. The band spans the
  full row, including the trailing film-moment link, which is the point: the row reads as one
  object rather than as a label with a chevron floating at the far right.
- **`hover-fold-toggle.png`** — pointer over mt#4250's `1m · thought, ran 18 shell commands`
  fold summary. Same treatment, which is the other half of this task: that control shipped a
  hand-picked `bg-muted/40` and now shares the `HOVER_ROW` constant.

## Why a settled transcript, and why the hover state is asserted rather than assumed

The first capture attempt used a LIVE conversation and produced a `hover-tool-row.png` that was
**byte-identical** to `rest.png` — the page re-rendered between the hover and the shot, so the
hover was lost and the screenshot recorded the resting state while looking exactly like a
successful capture. `hover` returning "Successfully hovered" is the ACTION succeeding, not the
OUTCOME.

So each hovered capture here is preceded by a `document.querySelectorAll(':hover')` read
asserting the intended element is genuinely in the hover chain, and the three files carry three
distinct md5 sums:

```
0fb31e1f3dd0e50c71de262486aecbfe  rest.png
50e137aaffc521c3be9253cc0eb05b5b  hover-tool-row.png
b033b387f09857e8f3c76962b0a2c7dd  hover-fold-toggle.png
```

## Measured, from the same session

The geometry claim the component suite cannot make — happy-dom has no layout engine, so
`getBoundingClientRect()` reads 0 there:

```
innerClass:  "group/call flex w-full items-center rounded hover:bg-muted/50"
innerWidth:  850    rowWidth: 850    spansFullRow: true
hoverRule:   ".hover\:bg-muted\/50:hover { background-color: oklch(var(--muted) / .5); }"
mutedToken:  ".18 0 0"   pageBackground: "oklch(0.078 0 0)"
```

Note on the sidebar's build stamp in these images: it reads `ui 34a5475a3 · svc 09e504018`.
The `ui` half is stamped at BUILD time from the then-current commit, and the bundle was built
from a working tree that already carried this task's edits — so the stamp is not evidence about
what the bundle contains. What is: the DOM read above, showing `hover:bg-muted/50` actually
served.
