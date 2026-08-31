# Cockpit UI — operator guide

Operator-facing reference for Cockpit's web surfaces. The architecture reference
(widget contract, VSM placement, subsystem map) lives in
[`docs/architecture/cockpit.md`](architecture/cockpit.md); this guide documents
what each surface is for and how to read it.

## The rail

The persistent left navigation spine (mt#2397). Top to bottom: the New
conversation action, the pinned Attention digest, the workstream spine
(Workstreams / Digest), then the Browse entity entry points, with Settings and
the build identity in the footer.

Below the `md` breakpoint (768px) the rail is replaced by a slim top bar and a
hamburger-triggered drawer carrying the same nav (mt#2604). The drawer is always
full-width — the collapse below applies to the desktop rail only.

### Collapsing it (mt#3700)

The rail collapses from 240px to a 56px **icon rail**, to give a wide-canvas
surface — the conversation film view above all, also the plant board and the
task graph — back ~184px of content width.

- **Toggle:** the panel icon at the right of the rail header (its only remaining
  control once collapsed, so the collapsed state is always self-reversing).
- **Shortcut:** `⌘B`. Suppressed while focus is in a text field, so it never
  fires out from under you mid-compose.
- **Collapsed, you keep:** every destination, as a centered icon whose tooltip
  and accessible name are still its label; the Attention digest's pending count;
  the New conversation action; Settings; and any failed-launch error.
- **Collapsed, you lose** (all restored by expanding): the wordmark's home link,
  the project filter, and the footer's build-identity sha. Note the project
  filter in particular — if you have scoped the cockpit to one project, that
  scope is still in force but is not visible in a collapsed rail.
- **Persistence:** stored per browser origin in `localStorage`, so it survives
  navigation and reload. If storage is unavailable the preference simply becomes
  session-ephemeral and the rail opens expanded.

### Keyboard shortcuts

| Chord            | Does                                  |
| ---------------- | ------------------------------------- |
| `⌘K` / `Ctrl+K`  | Open the command palette              |
| `⌘B`             | Collapse / expand the rail            |
| `⌘⇧O`            | Start a new conversation              |
| `⌘⇧[` / `⌘⇧]`    | Previous / next tab, in strip order   |
| `⌃Tab` / `⌃⇧Tab` | Previous / next tab, in recency order |
| `⌘W`             | Close the tab you are looking at      |
| `⌘⇧W`            | Close the cockpit window              |

The first five yield to text entry. The tab-cycling chords are reserved by
browsers for their own tab switching, so they fire only inside the cockpit tray
window and are simply inert in a browser tab.

`⌘W` / `⌘⇧W` are tray-window only for a different reason: they are entries in
the Window menu, so a browser tab keeps browser behavior (`⌘W` closes the
browser tab). In the tray, `⌘W` closes the active entity tab — the browser
mapping, which is why window-close moved to `⌘⇧W`. On a list page or the
dashboard there is no tab in view, so `⌘W` does nothing rather than closing the
window out from under your working set.

## The side peek (mt#3694)

Clicking an entity reference — an `mt#NNNN` in prose, an ask, a memory, a
changeset, anywhere one is rendered — opens that entity in a **side pane over the
current page** instead of navigating to it. The page behind stays exactly where
it was: same scroll position, same loaded data, same URL path. Closing the pane
costs one Esc and returns you to what you were reading, with nothing left behind.

**"A reference" includes the ones an agent typed.** Whether the cockpit recognized
a bare `mt#NNNN` in the text, or the agent wrote the link itself as
`[mem#728](minsky://memory/…)`, the same click peeks. Until mt#4351 the second
kind navigated away instead — which made memory and task links inside stored
conversations behave differently from the identical reference on a memory or task
page, since that is the form agents are told to emit.

Peeking deliberately does **not** open a tab. The tab strip records where you have
NAVIGATED; a peek is the path that does not navigate, which is the whole reason it
is cheap.

| Gesture                        | Does                                                      |
| ------------------------------ | --------------------------------------------------------- |
| Click a reference              | Peek it — **replacing** whatever pane is already open     |
| `⇧`-click a reference          | **Hold** the current pane; the next click opens beside it |
| `⌘`/`Ctrl`-click, middle-click | Promote: open as a full page (and therefore as a tab)     |
| Click anywhere off the peek    | Close **every** open pane at once                         |
| `Esc`                          | Close the newest pane (repeat to unwind held panes)       |
| Browser Back                   | Close the newest pane                                     |
| Header pin control             | Hold this pane, same as `⇧`-click                         |
| Header ↗ control              | Open this pane's entity as a full page                    |
| Drag the peek's left edge      | Resize the peek; the width is remembered                  |
| Double-click that edge, `Home` | Forget your width and go back to the default              |

**Holding is how you compare two things.** By default one pane is open at a time
and each click reuses it, so reading down a conversation never accumulates panes.
When you want to keep something on screen while you look at the next thing, hold
it — and because every extra pane costs a deliberate gesture, there is no cap and
nothing is ever evicted or buried behind something else.

**Clicking away closes the whole peek; `Esc` takes it apart one pane at a time.**
Those are deliberately different, because they answer different intentions: a
click on the page behind means you are done peeking and want the page back, while
`Esc` is how you dismantle a held pair a pane at a time. "Away" means away from
the peek as a whole — clicking one pane never closes the pane beside it, and
clicking an entity reference opens that entity rather than closing anything, so
neither reading a held pair nor walking from one entity to the next can dismiss
the assembly out from under you. Tabbing into the page behind is not a dismissal
either; only a click is — and neither is dragging the peek's own edge to resize it.

**How wide the peek gets is yours.** Drag the seam along its left edge, or focus
it and use the arrow keys (`⇧` for bigger steps); the width you land on is
remembered for next time. Double-click the seam, or press `Home`, to forget it and
go back to the default. Two bounds you cannot drag past: the peek never gets so
narrow that it stops being readable, and it never takes so much of the window that
the page behind loses its majority — the second one tightens as you hold more
panes, since the whole row has to fit. If you want a full-width view of something,
that is what the header's ↗ control is for.

**A peek is addressable and disposable.** The open panes live in the URL as a
`?peek=` parameter, so copying the link, sharing it, or reloading brings the same
panes back. Nothing is persisted anywhere else: navigate away from the page you
peeked FROM and the whole assembly is gone.

Every routable entity type now renders a real pane body (mt#4069 closed the last
four — asks, sessions, conversations and interceptors). The convention that got it
there still holds: a peek renders the same component the entity's full page
renders, never a separate compact copy that could quietly drift out of agreement
with it.

### The pane is a glance column, not a narrow page (mt#4123)

Same component, different render context — and the pane supplies the context:

- **The pane owns the gutters.** `SheetBody` and `SheetHeader` carry matching
  horizontal padding, so no body has to remember to pad itself and none of them
  can disagree about where the column's left edge is.
- **One scrollport per pane.** The pane scrolls; bodies do not scroll inside it.
  A body that caps its own height and adds its own scrollbar produces a scrollbar
  inside a scrollbar, with the outer one left almost nothing to move.
- **The pane is the frame.** A body drops its card border and background tint
  here — a second frame drawn a gutter's width inside the first reads as a
  mistake, and the pane already says where the content begins and ends.
- **Width is proportional below ~924px.** The pane is 26rem wherever there is
  room, and yields to 45% of the viewport below that, so the page behind keeps
  the majority column at every window size. A peek that takes two-thirds of a
  narrow window has defeated its own purpose.

Bodies find out which context they are in from their `WidgetVariant`: `peek`
rather than `page-body`. `page-body` means "inside a route wrapper", and every
route that uses it supplies padding and a measure the pane does not — composing it
in a pane renders a page-density layout with the page removed from around it,
which is what mt#4123 was filed for.

The geometry is verified in a real browser by
`scripts/verify-peek-pane-layout.ts`, because none of it can be asserted under
happy-dom (no layout engine — every measurement reads 0).

## Plant Board (`/plant`)

A single whole-system view: all of Minsky on one board, laid out on the VSM
five-organ skeleton in a process-engineering (P&ID) visual language. Reached via
the **Plant** entry in the cockpit rail, or directly at `/plant`. (The home
page is the triage radiator since mt#2881 — needs-you band, fleet strip,
substrate line — not a widget grid; navigation lives in the rail, mt#2398.
The `/agents` fleet table defaults to **needs-me-first** ordering since
mt#2884: rows needing the operator — an open bound ask, or a non-terminal PR
on a recently-active lane — rank above working/idle/done, with recency only
within a band; the liveness dot and the needs-me badge are two independent
status channels, and the absence of a badge is the calm state. An explicit
`?ag_sort=` URL param still selects any other ordering.)

Its purpose is comprehension and observability-in-the-felt-sense: see the system's
structure, watch it breathe, and build an intuitive model of its rhythms over time
(the design rationale is task mt#2375).

### The organs

- **S1 · Operations** — the process line: TASKS → READY → SESSIONS → AGENTS → PR →
  REVIEW → DONE, with the CHANGES_REQUESTED recirculation arc.
- **S2 · Coordination** — interlock valves (◇) on the S1 pipe (the derived hook fleet;
  "hook" names the Claude Code registration mechanics, "interlock" the domain
  noun — see `src/cockpit/CLAUDE.md` §Vocabulary, mt#2626).
  The fleet's derived count is a badge on the DONE valve — see
  [Slow-clock topology + interlock history](#slow-clock-topology--interlock-history-mt2602) below.
- **S3 · Management + 3★** — instrument gauges, each drawn with its real alarm setpoint.
- **S4 · Future** — backlog feed tank + deploy loop.
- **S5 · Identity** — rules/decision-defaults canopy and the operator node.
- **Attention seam** — the pink channel coupling the system to the operator
  (ask ↑ / decision ↓).
- **Learning loop** — failure → retrospective → memory → rule → welded interlock.

### Idle-honesty gestures

The board only moves when something is genuinely happening. Three motions exist,
all CSS-driven and all gated by `prefers-reduced-motion` (a reduced-motion user
sees a fully static board):

- **3★ scan sweep** — slow audit sweep across the S1 line (`vsm-scan`, a CSS
  `stroke-dashoffset` animation — deliberately **not** SVG SMIL, so reduced-motion
  disables it).
- **Tank breath** — slow level oscillation on the tanks (`vsm-breath`).
- **Ask pulse** — the seam circle pulses while an ask is pending (`vsm-ask-pulse`).

No motion is ever decorative: a calm system reads calm. (The honest-motion law is
specified in mt#2375.)

### What's real in v1

This is the v1 slice (mt#2376). Exactly **one** level is wired to live data: the
**READY tank** count, fetched from `/api/tasks`. Every other level/gauge is a
clearly-marked placeholder (`—`).

- **v2** (mt#2377) wires the fast-clock dot-motion from the `system_events` log
  (extends mt#2092) so entities visibly move on real transitions.
- **v3** (mt#2378) adds the time-scrubber and the phone vital-signs form factor.

### Slow-clock topology + interlock history (mt#2602)

The board's SLOW timescale ("plant grows valves") is real: the S2 valve
inventory and the Learning Loop's interlock count are derived from the live
guard-hook registry (`.claude/hooks/` / `.minsky/hooks/`), not a hardcoded
constant.

- **S2 valve count badge** — the plant keeps its 4 fixed positional valves
  (one per hook would be unreadable at the real hook count, currently
  ~48); the DONE valve instead shows a small **`N interlocks`** badge with
  the derived total. Before the first slow-clock sweep completes, the badge
  is honestly absent rather than showing a fabricated zero.
- **Interlock history** (absorbed into `/interceptors` by mt#4229; still reached
  via the Learning Loop node's "interlock history →" link, which now lands on the
  catalog, and per-entry on `/interceptors/:name`) — for every derived interlock:
  its **install date** (from `git log`, oldest add-commit per hook file),
  a **commit link** to GitHub, and — where derivable — the **originating
  `retrospective.fired` event** (mt#2537) that produced it. Retrospective
  correlation is two-tier: an exact match on the task ref parsed from the
  install commit's subject (`type(mt#N): ...`), falling back to the nearest
  preceding retrospective within a 14-day window. Neither match renders
  "unknown" — never a guessed link.
- **Cadence** — derivation (a bounded `git log` read + a DB query) runs
  server-side at cockpit boot and on an hourly-class sweep; the widget never
  spawns git or queries the DB per request. A new hook merged to main
  appears on the board within one such refresh.

### Tokens

The seven VSM organ colors are cockpit-local OKLCH tokens (`--vsm-s1` … `--vsm-learn`)
defined in `src/cockpit/web/index.css` and documented in
[`docs/brand-system.md`](brand-system.md) §2. They follow the brand system's
semantic-token discipline — no raw hex on the surface.

## Agents / unified run list (`/agents`, mt#2767, mt#4733)

The Agents page merges every kind of active work into one list — Minsky workspace
sessions, standalone harness conversations, and collapsed subagent/unattributed
groups — instead of separate pages per kind (mt#2767, "unified run list"). Each row
carries a **Kind** badge, and the control bar's **Kind** dropdown filters to one:

| Kind badge       | Row represents                                                                                                                                                                                                                                                                                                      | Click behavior                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**        | A dispatched Minsky workspace session (`kind: "dispatched-agent"`).                                                                                                                                                                                                                                                 | Opens the workspace detail route.                                                                                                                                 |
| **Conversation** | A standalone harness conversation with no workspace link and no spawn parent (`kind: "principal-conversation"`) — e.g. the operator's own chat.                                                                                                                                                                     | Opens the conversation route.                                                                                                                                     |
| **Subagent**     | One or more subagent conversations collapsed under a parent that isn't in the current view (`kind: "subagent-group"`). Synthetic — not a real entity.                                                                                                                                                               | Not a link; expands to reveal the nested conversations, each of which links individually.                                                                         |
| **Drivable**     | An app-started driven session (mt#2752) — the input-capable surface at `/driven/:id`.                                                                                                                                                                                                                               | Opens the drive view.                                                                                                                                             |
| **Unattributed** | The collapsed aggregate of every NULL-project-attribution conversation (and NULL-attributed subagent whose out-of-view parent can't be resolved) under a **specific** project filter (mt#4733). Synthetic — not a real entity, and only ever appears when `?project=` names one project rather than "All projects". | Not a link; expands to reveal the individual unattributed conversations, each of which links individually — same collapsed-container shape as **Subagent** above. |

**Why "Unattributed" exists:** `agent_transcripts.project_id` is resolved
best-effort at ingest and is nullable by design, so a specific project filter's
window query includes every NULL-attribution conversation alongside the filtered
project's own rows (never silently hiding one whose attribution failed to
resolve). Rendering each as its own peer row floods a narrow filter — live-measured
at a 45:2 ratio against one project's own activity — so they collapse into this
one row instead. Full mechanism: `src/cockpit/widgets/run-merge.ts`'s module
header ("Collapsed rendering under a narrow filter").

## Driven sessions (`/driven/:id`, mt#2750–mt#2752)

The drive surface of the harness-host ladder (umbrella mt#2230): the cockpit
daemon spawns a genuine `claude` binary as a managed child and the SPA renders
its live stream with an input composer. **Local daemon only** — never mounted on
the public (Railway) deployment; the invariant is genuine binary + the
operator's own credentials + the operator's own machine.

### Launching (mt#2752)

- **From a task** — the task detail page (`/tasks/:id`) shows a **Start
  session** button for tasks in a startable (non-terminal) status. One click
  binds-or-creates the task's workspace via the real `session_start` machinery,
  spawns the driven session with the workspace as its working directory, and
  lands you in the live view at `/driven/:id`.
- **Scratch** — the Agents page (`/agents`) has a **Start scratch session**
  button: an untasked session in the daemon's own repo directory, clearly
  labeled `Scratch:` in the run list.
- Both launch buttons name the permission mode in their tooltip. The default is
  `bypassPermissions` (headless print-mode sessions have no prompt UI to answer
  with); for task-bound sessions the isolated workspace clone is the
  containment.
- **Model (mt#3040)** — each task-detail launch control carries a model picker
  beside the button. It defaults to **Sonnet** and offers the dispatch tiers
  (Sonnet / Opus / Haiku / Fable) from the registry in
  `src/cockpit/web/lib/dispatch-models.ts`; the selection is passed to the
  spawned binary as `--model <alias>`. It is a defaulted-with-visible-override
  control, not a required per-launch choice — leaving it untouched reproduces
  the previous behavior exactly. Reach for a stronger tier when the task
  warrants it (the originating case: "this one needs Fable").
- **MCP tools (mt#3377)** — a driven session is provisioned with the `minsky`
  MCP server explicitly, via `--mcp-config` plus `--strict-mcp-config`, so the
  agent has the `mcp__minsky__*` toolset rather than shelling out to the CLI.
  This is required because the child's working directory is a workspace clone,
  and Claude Code resolves MCP servers per-project: the operator's `.mcp.json`
  lives in the main checkout and is gitignored, so a clone inherits none of it.
  `--strict-mcp-config` keeps the surface from varying with whichever claude.ai
  connectors and plugins the operator happens to have configured. Each session
  costs one additional `minsky mcp start` process (~57 MB RSS, measured
  2026-07-30); if concurrent driven sessions routinely exceed ~4, revisit
  against the hosted-HTTP server option (mt#2141).
- **Which servers (mt#4239)** — `cockpit.drivenSession.mcpServers` selects the
  set, resolved by name against the operator's `.mcp.json` in the **daemon's**
  checkout (not the session clone, which never has one) and copied verbatim.
  Default `["minsky", "github"]`; override with
  `MINSKY_COCKPIT_DRIVEN_SESSION_MCP_SERVERS` (comma-separated). `minsky` is
  always present and always synthesized — it must point at the running build and
  this session's repo path, so an inherited entry of the same name never shadows
  it.

  Two exclusions are deliberate. **`supabase` is resolvable but not a default**:
  driven sessions run under `bypassPermissions` and can be triggered from a phone
  unattended, and that server carries `execute_sql` / `apply_migration` against
  the production project — adding it is an explicit operator decision.
  **Remote/OAuth servers are refused outright**, with a log line naming the
  server: a headless `claude -p` child cannot complete an OAuth flow (verified
  live against claude 2.1.226; vendor-documented at
  code.claude.com/docs/en/mcp), and because `-p` waits for pending servers before
  the first turn, emitting one would cost up to `MCP_TIMEOUT` — 30s by default —
  of dead latency on **every** spawn while still delivering no tools. Notion is
  the motivating case and is tracked separately at mt#4242.

  Verify a real spawn with
  `bun scripts/verify-driven-session-mcp-config.ts <workspace> <daemon-checkout>`,
  which probes a tool from every provisioned server rather than assuming a
  declared server is a reachable one.

### Reading the run list

Driven sessions appear in the unified `/agents` run list alongside observe-only
rows. What the marker carries is **controllability** — whether the cockpit can
send this conversation a turn — and it is labeled **Drivable** (amber):

- A standalone **Drivable**-badged row is an app-started session; opening it
  goes to the drive view (`/driven/:id`).
- A workspace (**Agent**) row with a small **Drive** chip has an app-started
  session bound to it — the chip links to the drive view; the row itself still
  opens the workspace detail page.
- iTerm/externally-started sessions never get the marker; they are readable but
  not yet controllable.

**Vocabulary (mt#3132).** The words "driven" and "observed" no longer appear in
user-facing copy anywhere in the cockpit. They named an implementation
distinction, not one the operator has any use for: the same conversation moves
between those states over its life. The surfaced vocabulary is "drive view" (the
input-capable surface) and "drivable" (a conversation the cockpit can currently
send a turn to). Route strings, identifiers and code comments keep the old
names — only the copy changed.

### The conversation route accepts both id spaces (mt#3132)

`/conversation/:id` is the read surface for every conversation, whichever
pipeline delivered it, and it accepts **either** id:

- a harness **conversation uuid**, or
- a session driver's spawn-time **local id** — a permanently valid alias, resolved
  internally rather than redirected, so stored links keep working.

Resolution is a lookup against the registry snapshot (`GET /api/driven-session`),
never a guess from the id's shape: a default local id is minted as
`randomUUID()`, so it is uuid-shaped and indistinguishable from a conversation
id by inspection, while an entity-thread local id is not uuid-shaped at all.

Before the harness `init` frame a session driver has **no** conversation id — there
is nothing to resolve the local id INTO — so the route renders a first-class
"starting" state rather than a 404, and advances on its own when the frame
arrives. A session driver that reached a terminal status without ever linking says so
instead of starting forever.

**The route is read-only.** No composer, send path, or session driver channel is
reachable on it — it never opens the driven WebSocket at all. Controllability
lives on `/driven/:id` until mt#3095's liveness-refusal gate exists and mt#3325
can mount a composer here safely.

### Runs of agent actions fold behind one line (mt#4250)

A stretch of **three or more consecutive machinery turns** between two things
the agent said renders as a single dim summary line rather than as N rows:

```
▸ 1m · thought, ran 2 shell commands, called minsky tasks_spec_patch, 4 reads
```

Click anywhere on the line to expand it into the individual rows; click again to
collapse. Expansion is **two-stage** — the fold opens to the per-call rows, and
each of those still has its own payload disclosure (mt#2790) beneath it. The
rows are genuinely absent while collapsed, not hidden with CSS, which is where
the density comes from.

**Nothing is ever lost.** Expanding a fold yields every action it stood for, in
order. The summary is a view, never a replacement for the record (mt#3845 SC6).

**What never folds**, so it cannot hide inside a calm-looking line:

- anything the agent or the operator _said_ — prose and user turns
- any call that **errored** or was interrupted. A failure SPLITS the run around
  it: summary, open error row, summary
- **spawn dispatches** — the violet badge is structure you orient by
- compaction boundaries, and harness retry turns
- `WebSearch`, `WebFetch` and `Skill` calls, which keep their own row
- runs of one or two turns, where a fold would cost more than it saves

**Mutating calls are always named.** The summary names every tool that CHANGED
something (`tasks_spec_patch`, `session_commit`) and reduces read-only calls to
a count. A tool the classifier does not recognise is named too, rather than
assumed harmless. Classification comes from `packages/shared/src/tool-effect.ts`
(mt#3847). This is deliberately unlike the Claude Code terminal, which renders
`called minsky` and drops which tool ran — fine when you are watching your own
agent live, wrong for someone auditing a run afterwards.

**Deep links open the fold they land in.** A turn address or film-moment link
that targets a call inside a collapsed run arrives with that run already open
and the row marked.

**Expand all / Collapse all** act on folds as well as on individual calls. Fold
state is per-view only — nothing is remembered between visits, so a historical
conversation reads the same on any day.

### Identity registration and deeplinks

App-started sessions register their workspace↔conversation identity **at spawn
time**: when the child's `system/init` event yields its harness session id, the
daemon writes a `driven_spawn` row (confidence 1.0) into `minsky_session_links`
(plus the `agent_transcripts` stub row the FK requires). The workspace detail
page therefore resolves the live conversation with no cwd-matching heuristics.
`minsky://session/<workspace-id>` deeplinks keep routing to `/agents/:id` (the
`minsky://` URI type set is pinned by ADR-022 stage 1); a banner on that page
links through to the drive view when a driven session is bound.

### Cost & usage (`/agents/cost`, mt#2753)

Every turn's terminal `result` event (per-turn `total_cost_usd`, token counts,
cache-creation/cache-read tokens, per-model `modelUsage` mix, duration) is
captured in the daemon host's event path and persisted to Postgres
(`driven_session_cost`, one row per turn — reuses the reviewer-service
cost-tracking shape from mt#2288/mt#2721 where sensible). The `/agents/cost`
page (linked from the Agents page header) reads the `driven-session-cost`
widget's rollup: a global aggregate (total spend at API rates, token totals, a
daily/monthly spend projection at the observed cadence) plus a per-session
breakdown table.

**Billing-premise note (2026-07-13):** the 2026-06-15 Agent SDK / `claude -p`
billing split was paused — headless usage currently draws from the operator's
subscription at $0 marginal cost. These numbers are the API-RATE EQUIVALENT
the stream's own `result` events report — consumption/rate observability and
re-application readiness, not a live dollar bill. See memory `2d6cdbaf`.

## Proposals (`/proposals`, mt#3331)

The operator-facing half of the EngProd toil-miner's curation gate (RFC Notion
`3ac937f0-3cb4-816e-8af7-e5380f10a24b`, Phase 1). The miner mines recurring
tool-call patterns from agent transcripts and files a BLOCKED
`engprod-proposal` task per surviving cluster; this surface is where an
operator reviews and disposes of those proposals.

Proposals are grouped by the mining run that produced them, each with its
evidence block (tool sequence, occurrence frequency, distinct sessions,
chain length) and rank within the run (by mined score, descending). Every
run — even one that filed zero proposals — shows its own counters (turns
scanned, clusters found, clusters sent to the LLM stage, suppressed
breakdown, LLM errors), so an operator can tell a healthy quiet run ("nothing
found this run") apart from one that errored.

- **Accept** unblocks the task (`BLOCKED -> TODO`) into the normal task
  lifecycle and records `accepted` in the ledger.
- **Reject** requires a free-text reason, closes the task (`BLOCKED ->
CLOSED`), and records `rejected` + the reason in the ledger — the ledger's
  re-surface threshold reads this verdict to decide whether the same
  recurring pattern is allowed to be re-proposed later (only once its
  observed frequency at least doubles).

Both actions write the task's status and the ledger's verdict in a single
database transaction — the ledger is the miner's only persistent memory of
past decisions, so a task update that lands without its matching ledger
write would let a rejected cluster silently reappear on the next mining run.

A proposal whose evidence predates every recorded mining run (an
interrupted/untracked tick — no `engprod_miner_runs` row survived) renders
under a distinct "No matching run record" heading rather than being
attributed to the wrong run.

## Operator endpoints

### `GET /api/engprod/proposals`

Read-only (no auth beyond the standard loopback/token gate — see
`docs/architecture/cockpit.md`'s auth posture). Returns
`{ runs: EngprodRunSummary[], proposals: EngprodProposalRow[] }`: every
`engprod-proposal`-tagged task (any status — an already-actioned proposal
still renders, showing its final disposition) plus the most recent mining
runs. Grouping-by-run and ranking are derived client-side
(`src/cockpit/web/lib/engprod-proposals.ts`).

### `POST /api/engprod/proposals/:taskId/accept`

Mutation (bearer/cookie auth, same as every other cockpit mutation
endpoint). No body. `404` if the task doesn't exist, `400` if it isn't
tagged `engprod-proposal`, `409` if it isn't currently `BLOCKED` (already
actioned), `500` if no matching ledger row exists (a hard failure — the task
write is rolled back rather than left to diverge from the ledger). On
success: `{ ok: true, taskId, status: "TODO" }`.

### `POST /api/engprod/proposals/:taskId/reject`

Mutation, same auth and guard sequence as accept. Body: `{ "reason":
"<non-empty free text>" }` — `400` if `reason` is missing, non-string, or
empty/whitespace-only. On success: `{ ok: true, taskId, status: "CLOSED" }`.

### `POST /api/driven-session`

Spawn a driven session (mutation — bearer/cookie auth). Body shapes, all
optional and `taskId`/`cwd` mutually exclusive (400 when both are present):

| Body                    | Behavior                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `{ "taskId": "mt#N" }`  | Task-bound: bind-or-create the task's workspace, spawn with cwd = the workspace directory. |
| `{ "cwd": "/abs/dir" }` | Explicit-directory launch (the original mt#2750 shape).                                    |
| `{}`                    | Scratch: cwd defaults to the daemon's own working directory; no task binding.              |

Optional on any shape: `"permissionMode": "bypassPermissions" \| "default"`, and
`"model"` (mt#3040) — a dispatch-model id from
`src/cockpit/web/lib/dispatch-models.ts`: `"sonnet"` \| `"opus"` \| `"haiku"` \|
`"fable"`. When present it is resolved to the spawned binary's `--model <alias>`
argument; an unrecognized id is rejected with `400` rather than silently falling
back to the default. Omit it to inherit the CLI's own default model.
Returns `201` with `{ sessionId, harnessSessionId, cwd, taskId,
minskySessionId, permissionMode, status, pid, startedAt, exitCode, argv }` —
`sessionId` is the spawn-time local id that addresses `/driven/:id` and the
per-session WebSocket. Companions: `POST /api/driven-session/:id/stop`
(graceful stop), `GET /api/driven-session` (registry snapshot, same row
shape), and `GET /api/driven-session/turn-active` (mt#3048 — cheap "is any
session mid-turn" signal consumed by the cockpit-tray watcher's pre-restart
gate; see `docs/architecture/cockpit.md`'s Operator endpoints table for
detail).

### `POST /api/driven-session/attach`

Attach a session driver to a conversation Minsky did **not** spawn — one the
operator started in their own terminal (mt#3095). Body: `{ "conversationId":
"<uuid>" }`. Mutation, same auth as the spawn route above.

Unlike the spawn route, this does not create a conversation; it puts an input
channel on an existing one, resolved from its on-disk transcript under
`~/.claude/projects/**`. On success the session behaves like any other driven
session — same row shape, same WebSocket, same cost/link recording.

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| `201`  | Attached. Body is the same session summary the spawn route returns.                    |
| `409`  | **Refused** — a writer holds (or may hold) the conversation. See below.                |
| `423`  | Another _cockpit_ session driver won the advisory lock. A retry may succeed.           |
| `404`  | No on-disk transcript for that id, or one with no recoverable cwd.                     |
| `400`  | Missing, empty, or syntactically impossible `conversationId` (rejected with zero I/O). |

**Why attach can be refused.** `claude --resume` has no multi-writer safety:
two processes resuming one conversation both succeed and both append to the
same transcript, recording the same `parentUuid` — a silent history fork with
no error surface. So the cockpit refuses unless the conversation is
demonstrably idle. Liveness comes from the hook-fed presence signal
(`GET /api/conversation/:id/presence`, mt#3201):

| Presence      | Attach | Rationale                                                         |
| ------------- | ------ | ----------------------------------------------------------------- |
| `IDLE`        | admit  | The designed case.                                                |
| `ENDED`       | admit  | Observed `SessionEnd`; nothing holds the file.                    |
| `LIVE`        | refuse | A writer is mid-turn.                                             |
| `NEEDS_INPUT` | refuse | A writer is attached and waiting on a human.                      |
| `STALLED`     | refuse | Last seen mid-work, since quiet — a wedged writer still holds it. |
| `UNKNOWN`     | refuse | No telemetry is not evidence of idleness.                         |

A `409` body carries `{ refused: true, presence, reason, message }`, where
`message` is operator-facing prose explaining the risk — render it rather than
the reason code. `reason` is one of `live-writer`, `awaiting-human`,
`possibly-wedged`, `no-telemetry`. A presence store that is unreachable refuses
as `no-telemetry` rather than admitting.

**Closed (mt#3453, merged 2026-07-31):** an attached conversation's pane used to
open EMPTY and fill from its next turn. The drive channel now replays the
conversation's on-disk history, so the pane opens with its prior turns.

### Memory curation (mt#4766)

`/memories` and `/memory/:id` gained row-level and bulk write actions — edit
tags, edit name/description, supersede, and hard delete — where previously
the cockpit could not change a memory in any way (the widget transport was
`GET`-only). Every mutation routes through the shared command registry
(`memory.update` / `memory.supersede` / `memory.delete`), never
`MemoryService` directly, per ADR-004: the command layer is where
`checkDerivation`, `validateAssociations` (ADR-012's closed association-type
vocabulary), and the `tracksTask` auto-derivation actually run, and a route
calling the service would silently skip all of them.

#### `PATCH /api/memories/:id`

Mutation (same auth gate as every other cockpit mutation endpoint — see
`docs/architecture/cockpit.md`'s auth posture). Body: any of `name`,
`description`, `tags` (string array), `associations`
(`Record<string, string[]>`). An unknown field, or a wrong-typed value for
one of these, returns `400` without reaching the command layer. `404` if the
memory does not exist. A non-empty `associations` value under a key outside
ADR-012's vocabulary is rejected `400` by the command layer itself (the
message names ADR-012 — this is the check that only exists because the route
goes through the command layer rather than the bare service). On success:
`{ record: MemoryRecord }`.

#### `POST /api/memories/:id/supersede`

Mutation. Body: `type`, `name`, `description`, `content`, `scope` (all
required non-empty strings; `type`/`scope` must be a valid enum value) plus
optional `projectId`, `tags`, `confidence`, `reason`. `400` on a
missing/invalid required field or an unknown field. `404` if the old memory
does not exist. On success: `{ old: MemoryRecord, replacement: MemoryRecord }`
— the old row's `supersededBy` points at the replacement's id.

**Actor attribution is server-ascribed, never caller-supplied.**
`sourceAgentId`/`sourceSessionId` are not accepted in the request body at
all — a request that includes either is rejected `400` as an unknown field —
and every replacement record's `sourceAgentId` is unconditionally set
server-side to the fixed `COCKPIT_OPERATOR_SOURCE_AGENT_ID` constant. This
applies mt#2898's finding on the ask-resolve route (`responder` read from the
request body, forgeable by any caller once a permission bridge started
trusting it) to a second entity before the same hole got dug twice.

#### `DELETE /api/memories/:id`

Mutation. Hard delete — the row is removed and the memory's embedding row is
best-effort removed from `memories_embeddings`. **There is no undo, and
unlike tasks (`deleted_task_ids`) memory has no short-id tombstone table** —
once a `mem#N` record is deleted, that short id can be reissued to a
different, unrelated future record. The cockpit's delete-confirmation dialog
states both consequences before the operator confirms. On success:
`{ deleted: true, id }`.

#### `POST /api/memories/bulk/retag` · `POST /api/memories/bulk/delete`

Mutation. Both follow `operational-safety-dry-run-first`: body
`{ "ids": string[], "execute"?: boolean }` (retag also takes
`"tags": string[]`). `execute` defaults to `false` (preview) — the response
lists exactly which records would change (id, current state, new state) with
no write performed. Pass `execute: true` to apply. A selection larger than
10 records (`BULK_RECORD_CAP`) is refused `400` regardless of `execute`,
naming the `operational-safety-dry-run-first` discipline rather than
silently truncating the selection.

### `GET /api/health`

The cockpit daemon exposes a lightweight health endpoint at
`GET http://localhost:3737/api/health`. Useful for scripts, uptime monitors, and
the tray app's health poll:

```json
{
  "status": "ok",
  "db": "ok"
}
```

The `db` field tracks the persistence-layer state (gh#1761):

| Value           | Meaning                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`          | DB connection is healthy; all persistence-backed widgets and endpoints work.                                                                                                                                                                                                                          |
| `"degraded"`    | At least one DB init attempt failed (circuit breaker tripped, connection timeout, etc.). The daemon stays up and serves the UI; widgets that need DB fall back gracefully. A background retry loop is running — see `docs/persistence-configuration.md §Cockpit daemon: circuit-breaker degradation`. |
| `"unreachable"` | No connection attempt has been made yet (initial state at boot, or after a singleton reset).                                                                                                                                                                                                          |

When `db` is `"degraded"` the daemon **does not restart** — it continues serving the
UI and re-attempts the DB connection every 30 s in the background. The tray app's
health indicator reflects the `db` field in addition to overall HTTP reachability.

## Cross-references

- mt#2375 — Plant Board design (the living plant; four timescales; honest-motion law)
- mt#2376 — v1 slice (this surface) · mt#2377 — v2 motion · mt#2378 — v3 scrubber/phone
- mt#2602 — slow-clock topology auto-derivation + interlock history
- mt#2626 — guard vocabulary alignment ("hook" = registration mechanics,
  "interlock" = domain noun, "weld" = verb only); route renamed from
  `/plant/weld-history`
- mt#2230 / mt#2237 / mt#2750 / mt#2751 / mt#2752 / mt#2753 — harness-host ladder:
  driven-session host, drive view, task-bound launch, cost/usage readout (the
  §Driven sessions surface)
- mt#2397 / mt#2604 / mt#3700 — the rail: persistent spine, mobile drawer, desktop collapse
  (the §The rail surface)
- mt#2767 / mt#4728 / mt#4733 — Agents unified run list, project-scoped filtering, the
  NULL-attribution collapse (the §Agents / unified run list surface)
- mt#4766 — Memory curation write path (retag / edit / supersede / delete),
  routed through the shared command registry per ADR-004 (the §Memory
  curation surface)
- [`docs/architecture/cockpit.md`](architecture/cockpit.md) — cockpit architecture reference
- [`docs/brand-system.md`](brand-system.md) — tokens, motion budget, `prefers-reduced-motion`
