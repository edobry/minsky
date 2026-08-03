# Cockpit UI — operator guide

Operator-facing reference for Cockpit's web surfaces. The architecture reference
(widget contract, VSM placement, subsystem map) lives in
[`docs/architecture/cockpit.md`](architecture/cockpit.md); this guide documents
what each surface is for and how to read it.

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
- **Interlock history** (`/plant/interlock-history`, reached via the Learning Loop
  node's "interlock history →" link) — a table of every derived interlock with:
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
  The server set is deliberately just `minsky` — `github`/`supabase` carry their
  own credential paths, so granting them is a separate decision — and
  `--strict-mcp-config` keeps the surface from varying with whichever claude.ai
  connectors and plugins the operator happens to have configured. Each session
  costs one additional `minsky mcp start` process (~57 MB RSS, measured
  2026-07-30); if concurrent driven sessions routinely exceed ~4, revisit
  against the hosted-HTTP server option (mt#2141).

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
- an actuator's spawn-time **local id** — a permanently valid alias, resolved
  internally rather than redirected, so stored links keep working.

Resolution is a lookup against the registry snapshot (`GET /api/driven-session`),
never a guess from the id's shape: a default local id is minted as
`randomUUID()`, so it is uuid-shaped and indistinguishable from a conversation
id by inspection, while an entity-thread local id is not uuid-shaped at all.

Before the harness `init` frame an actuator has **no** conversation id — there
is nothing to resolve the local id INTO — so the route renders a first-class
"starting" state rather than a 404, and advances on its own when the frame
arrives. An actuator that reached a terminal status without ever linking says so
instead of starting forever.

**The route is read-only.** No composer, send path, or actuator channel is
reachable on it — it never opens the driven WebSocket at all. Controllability
lives on `/driven/:id` until mt#3095's liveness-refusal gate exists and mt#3325
can mount a composer here safely.

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

Attach an actuator to a conversation Minsky did **not** spawn — one the
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
| `423`  | Another _cockpit_ actuator won the advisory lock. A retry may succeed.                 |
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
- [`docs/architecture/cockpit.md`](architecture/cockpit.md) — cockpit architecture reference
- [`docs/brand-system.md`](brand-system.md) — tokens, motion budget, `prefers-reduced-motion`
