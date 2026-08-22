# Cockpit

Operator-facing mission-control web app for Minsky. Local-only v0 (`minsky cockpit`); web-primary, no TUI investment. Architecture is shell + widget framework — each widget is a self-contained module declaring its data dependencies, shipping independently, degrading gracefully when dependencies aren't ready.

Parent task: mt#1143. Engineering bundle: mt#1768.

## Stack

| Layer           | Value                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Bun                                                                                                                 |
| Server          | Express (`src/cockpit/server.ts`)                                                                                   |
| Frontend        | React + Vite + Tailwind + shadcn/ui + TanStack Query (`src/cockpit/web/`)                                           |
| Widget contract | Custom registry (`src/cockpit/widget-registry.ts` + `types.ts`)                                                     |
| Config          | None per-widget (registry-gated, mt#2294); future cockpit config → `cockpit` tree in `~/.config/minsky/config.yaml` |

Deeper engineering conventions: `src/cockpit/CLAUDE.md` (auto-loaded for any file under `src/cockpit/**`).

## Shell

The app shell (mt#2397/mt#2398) is a persistent left **rail** (attention digest pinned at
top → workstream spine → browse entity entry points; replaces the former hamburger/NavSheet
overlay) beside a **tabbed workspace**: list pages navigate the main pane, while entity
details (a task at `/tasks/:id`, a conversation at `/conversation/:id`, a workspace at
`/agents/:id`) open as URL-driven tabs in a
working-set strip (`TabBar`, hidden when empty; state in localStorage). The ⌘K command
palette is mounted globally.

### Side peek (mt#3694)

Over that shell sits a **side peek**: clicking an `EntityRef` opens the entity in a pane
above the current page rather than navigating to it (`PeekHost`, mounted in `Layout` as a
sibling of `<main>` so the page behind stays mounted). Operator-facing behavior and gestures:
`docs/cockpit-ui.md` §The side peek.

Three properties are load-bearing and easy to break:

- **The pathname never changes.** Pane state lives entirely in a `?peek=` query parameter,
  derived on every render with no second copy (`lib/peek.ts`). That is simultaneously why the
  peek is URL-addressable, why Back closes it, why the pane LIST is ephemeral with nothing
  persisted — and why it opens no tab, since `TabsProvider`'s open-on-visit effect keys on
  `matchEntityRoute(pathname)` and a search-only change cannot reach it. **A peek therefore
  cannot be implemented as a route change**; that is the constraint the whole design turns on.

  Read "nothing persisted" as scoped to the pane list, which is what the URL contract is about.
  The pane WIDTH is a separate dimension and deliberately does persist, in `localStorage` via
  `lib/peek-width.ts` (mt#4261) — a durable preference about this screen rather than part of the
  peek's address, so a copied peek link carries which entities are open and never the copier's
  window size.

- **The panes are non-modal, and an outside CLICK dismisses the whole assembly.** Coexisting
  with a live page is the feature, so there is no scrim and clicks reach the page behind. What
  "outside" means is the load-bearing part: Radix computes it PER PANE, and taking that reading
  literally would break the hold gesture — a shift-click lands outside the open pane, so the
  pane would close at the same moment the hold opened the next one. `lib/peek-dismiss.ts` owns
  the verdict instead, exempting every pane, every entity ref, and the assembly's own chrome
  (mt#4143 per operator decision ask#8509; the chrome exemption is mt#4261's resize divider,
  which is a flex sibling of the panes and so "outside" all of them). Esc remains the
  one-pane-at-a-time unwind, and the FOCUS path never dismisses — tabbing behind a pane is not
  a dismissal gesture. Non-modal also means panes do NOT trap focus (verified in
  `@radix-ui/react-dialog@1.1.15`: `DialogContentNonModal` sets `trapFocus: false`), which is
  unavoidable — a focus trap needs exactly one region to trap into, and the hold gesture
  allows two live panes.
- **One renderer per entity.** A peeked entity renders the SAME component its full page
  renders (`PeekBody`), never a compact second implementation that would drift. Types without
  a shareable body render an open-as-page affordance carrying no entity fields rather than a
  miniature stand-in; `PEEKABLE_WITH_BODY` pins the split and a test asserts the exact list
  (mt#4069 completes it).

The pane-list algebra and wire format are pure and separately tested (`lib/peek-codec.ts`) —
an ordinary open replaces the last pane, a held pane survives so the next lands beside it, and
growth costs a gesture per pane, so there is no cap or eviction policy.

### Keyboard shortcuts

| Chord            | Action                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `⌘K`             | Open the command palette (`CommandPalette.tsx`)                                                     |
| `⌘⇧]` / `⌘⇧[`    | Next / previous tab in **strip** order, wrapping at both ends (mt#3469)                             |
| `⌃Tab` / `⌃⇧Tab` | Next / previous tab in **recency** order; holding `⌃` walks a frozen order, as in VS Code (mt#3469) |
| `⌘W`             | Close the **active** tab; inert when no entity tab is in view (mt#4059)                             |
| `⌘⇧W`            | Close (hide) the cockpit window — where plain `⌘W` used to sit (mt#4059)                            |

The palette and the tab-cycling chords are suppressed while focus is in a text
input, textarea, select, or contenteditable host. `⌘W` and `⌘⇧W` are not: they
are macOS **menu accelerators** (Window ▸ Close Tab / Close Window), which fire
regardless of focus and never reach the document. That is the point of the
choice — an accelerator also renders its chord in the menu, and does not depend
on a chorded key being delivered to the webview, which is the open question
mt#3475 tracks for the cycling chords above. `⌘W` reaches SPA state through the
ADR-023 native→SPA seam: `menu.rs eval_close_active_tab` evals
`window.__minskyCloseActiveTab`, installed by `components/TabCloseBridge.tsx`.

**The tab shortcuts only work in the Tauri cockpit window, not in a browser tab.** Browsers
reserve those chords for their own tab strip and never deliver them to the page, so there they
are inert by construction — no detection or feature flag is involved. Owner:
`components/TabKeyboardNav.tsx`; the ordering primitives it drives (`stepInOrder`,
`mruOrderedPaths`) live in `lib/tabs.tsx`. `⌘1`–`⌘9` ordinal jumps are deliberately absent:
they need a spatially stable strip, which the working-set model does not guarantee.

Two id-spaces (mt#2398/mt#2420/mt#1919 — do not conflate; vocabulary per ADR-022 stage 1,
mt#2686): `/agents` and `/agents/:id` are keyed by the **Minsky workspace sessionId**
(`SessionRecord`); `/conversations` and `/conversation/:id` are keyed by the **harness
agentSessionId** (ingested transcript). The workspace detail page bridges the two, linking to the
conversation at `/conversation/:agentSessionId` (served by `GET /api/agents/:id`). (`/agents` and
`/agents/:id` keep their existing names — the Agents list/detail pair is a separate naming
decision, out of scope for the ADR-022 rename.)

### How the workspace ↔ conversation link resolves (mt#2768, mt#3529)

`GET /api/agents/:id` returns a `conversations[]` array of candidates, each
`{ agentSessionId, startedAt, source }`. **`source` is the provenance discriminator** and takes
one of two values — the union is declared once, in `src/cockpit/conversation-link-source.ts`, and
imported by both the server route and the SPA type:

| `source`           | Meaning                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link-row`         | A row a writer stamped in `minsky_session_links` (`session_creator`, `pr_author`, `subagent_spawn`, `driven_spawn`, `cwd_match`). The authoritative case.     |
| `derived-agent-id` | Derived from the workspace record's own `agentId` when NO writer stamped a row (mt#3529). Existence-checked against `agent_transcripts` before being emitted. |

Resolution order: link rows first; the derived fallback runs **only when the link-row query
returns empty**, so a stamped row always wins and the two can never both appear for one workspace.
The derived candidate carries `confidence: null` — there is no writer confidence to report, and
inventing one would let it sort against real values.

Two properties keep a derived link honest, and both are deliberate rather than incidental. It is
**existence-checked**, so it can never point the Conversation tab at a conversation this
deployment has not ingested. And it is **marked rather than folded in**, because ADR-006
§Consequences states the identity scheme has _"No forgery defense"_ — a self-declared `agentId`
is a weaker basis than a row a writer stamped, and a consumer that cares about the difference must
be able to see it. Only ADR-006's `conv` scope yields a candidate: `unknown:hash:*`, `proc`,
`inst`, and `run` name something that is not a conversation, so those workspaces keep reporting
an empty `conversations[]`.

Note for consumers: `source` was ADDED to existing `conversations[]` elements; no field was
removed or renamed. Clients that ignore unknown properties are unaffected. The SPA reads it via
`ConversationCandidate` in `web/widgets/RunDetail.tsx`. `mt#2768` deleted an earlier `cwd LIKE`
fallback — that was a heuristic, and nothing here reinstates one; `SessionRecord.agentId` is a
recorded fact about the workspace, which is why it is an admissible source where cwd-matching was
not.

## Routes

| Path                       | Page                | Purpose                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | Home                | Triage radiator (mt#2881): needs-you band (all pending asks, tier-ranked, flood-collapsing, tier-distribution health chip) + fleet liveness strip + substrate band (one calm line when healthy; anomalous subsystems expand to their full status cards); the rail is the navigation surface (nav tiles removed, mt#2398)              |
| `/agents`                  | Agents              | Workspaces in flight — rows open the workspace detail at `/agents/:id`                                                                                                                                                                                                                                                                |
| `/agents/:id`              | Workspace detail    | Workspace entity tab — liveness, linked task, recent commits, PR state, conversation link (mt#1919; `WorkspaceDetailPage`/`WorkspaceDetail`, renamed from `SessionDetailPage`/`SessionDetail` by mt#2686)                                                                                                                             |
| `/conversation/:id`        | Conversation        | Conversation entity tab — readable conversation view of the transcript (mt#2374; supersedes the interim `/conversation` verification host; path renamed from `/session/:id` by mt#2686)                                                                                                                                               |
| `/context`                 | Context             | Agent context inspector                                                                                                                                                                                                                                                                                                               |
| `/workstreams`             | Workstreams         | Active work streams; `?altitude=` selects the slice (see Widget parameterization)                                                                                                                                                                                                                                                     |
| `/tasks`                   | Tasks               | List + graph subpages (`/tasks/graph`, `/tasks/:id`)                                                                                                                                                                                                                                                                                  |
| `/asks`                    | Asks                | Interactive ask management                                                                                                                                                                                                                                                                                                            |
| `/proposals`               | Proposals           | EngProd toil-miner curation gate (mt#3331): filed `engprod-proposal` tasks grouped by mining run, with evidence + Accept/Reject (task status + ledger verdict, atomically — see `src/cockpit/routes/engprod-proposals.ts`)                                                                                                            |
| `/activity`                | Activity            | Event stream                                                                                                                                                                                                                                                                                                                          |
| `/embeddings`              | Embeddings          | Provider health + index coverage                                                                                                                                                                                                                                                                                                      |
| `/memories`                | Memories            | Memory subsystem — browse, search, stats, detail, health (mt#2150)                                                                                                                                                                                                                                                                    |
| `/settings`                | Settings            | Cockpit configuration + credentials                                                                                                                                                                                                                                                                                                   |
| `/plant`                   | Plant Board         | Whole-system VSM plant board (mt#2375+); S2 valve interlock count is derived (mt#2602)                                                                                                                                                                                                                                                |
| `/plant/interlock-history` | (redirect)          | **Absorbed into `/interceptors` (mt#4229)** — redirects. Its install date / commit link / `retrospective.fired` correlation now render on the interceptor detail view, joined on the catalog's `sourceFile`. Two pages listed the same corpus with different memberships; the redirect is kept for bookmarks, per ADR-020's precedent |
| `/interceptors`            | Interceptors        | The enforcement corpus: what intercepts, where on the turn, what it costs, and — since mt#4229 — when each one landed (mt#4010, mt#4056, mt#4057)                                                                                                                                                                                     |
| `/shares`                  | Shared links        | Inventory of conversations published as public read-only links — live and revoked, with last-access time and a revoke control (mt#4024)                                                                                                                                                                                               |
| `/s/:token`                | Shared conversation | **The only PUBLIC page.** One conversation, read-only, no account required, no cockpit chrome. Mounted as a sibling of `AuthGate`/`App` in `main.tsx`, not as a route in this table's tree (mt#4024) — see §Published conversation share links                                                                                        |

### HTTP error semantics: 503 is a database outage, 500 is a bug (mt#4125)

Every cockpit API handler distinguishes the two, and callers should too:

| Status  | Means                                                                                                                                              | Caller should                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **503** | The persistence layer is unreachable — pool exhaustion, a dropped connection, no provider configured. Body: `Service unavailable — <description>`. | Treat as transient. Keep polling; render a "store unavailable" state rather than a failure. |
| **500** | An error in the handler itself.                                                                                                                    | Treat as a defect.                                                                          |

The classification runs through `respondIfDatabaseUnavailable`
(`src/cockpit/db-unavailable-response.ts`), which wraps `isDatabaseUnavailableError` (mt#3398).
That predicate walks the error's `cause` chain, which is load-bearing: drizzle wraps the driver
error and carries the QUERY TEXT as the wrapper's own message, so a non-walking check sees a query
string and concludes "application bug" for what is really an outage.

**This changed in mt#4125.** Before it, the predicate had 3 adopter call sites against 42
unconditional `status(500)` sites, so a pool exhaustion was reported to the operator as an
application bug — mt#4086 is the worked instance (`GET /api/changesets`, Supavisor
`EMAXCONNSESSION`). Any runbook or note written before that date describing a cockpit route as
returning 500 on a database outage is now wrong for the outage case; 500 still means what it always
did for handler defects.

Callers with a generic `if (!res.ok)` path are unaffected — both statuses are non-ok and render the
same error state. A guard test in `src/cockpit/db-unavailable-response.test.ts` asserts the whole
HTTP layer keeps classifying, and carries the enumerated exceptions (500s with no error object to
classify) with their reasons.

## Widgets

Each widget declares an `id` matching `WidgetModule.id` in its backend module under
`src/cockpit/widgets/`, registered in `src/cockpit/widget-registry.ts`. **Registering a
widget is sufficient** — its data endpoint (`/api/widget/<id>/data`) is served whenever the
widget is in the registry. There is no per-widget enable flag and no `cockpit.json` config
file (both removed in mt#2294); widgets auto-work on first run with no manual config edit.

The model separates two concerns the old `enabled` flag conflated:

- **Capability** — "does this widget's data endpoint work" — is owned by the registry. A
  registered widget always serves; an `id` not in the registry returns `HTTP 404
"Widget not found"`; a registered widget whose backend is unavailable returns its
  graceful-degraded payload (`{ state: "degraded", reason }`) rather than a 404.
- **Layout** — "which cards the home System-status grid renders" — is decided on the
  frontend (`src/cockpit/web/App.tsx`), from the registry plus the renderer maps; it is
  not operator-configurable today.

Any future cockpit configuration (e.g. polling intervals) lives under a `cockpit` tree in
the main Minsky config (`~/.config/minsky/config.yaml`), not a separate file.

### Query-layer-failure vs no-data convention (mt#2758)

`WidgetData`'s `{ state: "ok" | "degraded" }` split is all-or-nothing per widget — it signals
that the WHOLE widget failed, not that one of several independent data sources inside an `ok`
payload silently failed. Widgets that fan out to multiple independent sources (several DB
queries, several HTTP probes) commonly degrade each source independently — a failing query
`catch`es to an empty default (`[]`/`null`/`0`) so one bad source doesn't take the rest of the
widget down. That per-source fail-open creates a structural blind spot: a source that failed
and a source that legitimately has no data both resolve to the same empty value, so "the query
layer is broken" and "there's genuinely nothing here yet" render identically. This is exactly
what happened to the reviewer-bot-status widget for ~5 weeks (mt#2076/mt#2757) — every DB query
threw `NOT_TAGGED_CALL` while the UI showed healthy-looking zeros, and nobody could tell from
the cockpit.

**Convention:** a widget with this shape adds ADDITIVE OPTIONAL fields to its own payload
(payload is `unknown` at the `WidgetData` level, so no framework change is needed) signaling
per-fetch-cycle failure counts alongside the real data. The reference implementation
(`src/cockpit/widgets/reviewer-bot-status.ts`) adds `queryFailureCount` / `queryTotalCount` to
its `db` sub-object: `queryFailureCount` counts how many of the widget's independent queries
failed to run for real (threw, rejected, or had no live connection) during the CURRENT fetch
cycle, and `queryTotalCount` is the denominator. The counter is computed as state local to the
fetch invocation (not module-level) — a widget that single-flights concurrent `fetch()` calls
(reviewer-bot-status does, mt#2765) would otherwise leak or double-count the failure signal
across polling cycles. A `degradedFields: string[]` naming the specific affected output fields
is an equally valid shape when per-field granularity is more useful than a count.

**Frontend rendering:** render a visible degraded indicator when the failure count is nonzero
— never let it fall through to the same rendering as "no data." `ReviewerBotStatus.tsx` renders
an `AnomalyBanner` when `db.queryFailureCount > 0`: the amber warning variant for a partial
failure, and the banner's `error` variant — which maps to the `destructive` semantic token per
`src/cockpit/CLAUDE.md`'s error-state convention — when every query in the cycle failed.

This is a reference-implementation convention adopted incrementally, not a framework
requirement — see the full type-level writeup in `src/cockpit/types.ts` above `WidgetData`.
Existing widgets are not required to adopt it in one pass; new widgets with a multi-source
fan-out shape should.

### Widget parameterization (slice/altitude)

Widgets are slice-parameterizable (mt#2385, Constraint-2 of the mt#2373 widget-contract
refactor): the data endpoint forwards URL query params into the widget's
`fetch({ id, query })` call (`WidgetContext.query`), so the SAME widget can return
different subsets/aggregations of its state space per request. On the frontend, params are
passed via `fetchWidgetData(id, params)` and carried in the TanStack Query key, so two
instances at different params cache independently — an instance is `(widgetId, params)`
materialized at the render site. A registry-level `WidgetInstance` abstraction is
deliberately deferred until the lens engine (mt#2372) needs declarative instance lists.

**Workstreams is the reference case.** `GET /api/widget/workstreams/data?altitude=<slice>`
selects one of three semantic slices (unknown/absent values fall back to `full`; the
applied slice is echoed in the payload as `altitude`):

| Altitude     | Slice                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `full`       | Default — the complete card view (parents + all children)                                                           |
| `rollup`     | Outcome rollup: card headers + counts only, no child rows                                                           |
| `actionable` | Actionable-now: children narrowed to IN-PROGRESS / IN-REVIEW / READY / BLOCKED; workstreams without one are dropped |

The `/workstreams` page reads `?altitude=` from the URL and renders a
Full / Rollup / Actionable toggle. Slice names are **semantic, not persona-named** —
lenses (user-definable modes that compose and parameterize widgets) are owned by mt#2372
and must not be hardcoded into widget vocabularies.

### Widget catalog by route

| Widget ID                                                                                     | Page                            | Surface                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attention`, `agents` (data), `mcp-server-status`, `reviewer-bot-status`, `embeddings-health` | `/`                             | Home triage radiator (mt#2881) — a FIXED curated composition, not a registry-driven grid: the needs-you band reads `/api/asks`, the fleet strip reads the `agents` widget, and the substrate band reads the three health widgets (anomalous ones expand to full cards). New registry widgets no longer auto-append to home.                   |
| `basic-health`, `credentials`                                                                 | `/settings`                     | Receipts (uptime/version/widgets-loaded via `BasicHealthBody`) + credentials manager — moved off home by mt#2881 (anomaly-over-inventory)                                                                                                                                                                                                     |
| `task-graph`, `task-list`, `workstreams`                                                      | Dedicated pages                 | Page route only; `workstreams` self-fetches with an `altitude` param (mt#2385)                                                                                                                                                                                                                                                                |
| `memories-health`                                                                             | `/memories`                     | Page-level health indicator (sourced from `EmbeddingsHealthTracker.getInstance().getSummary()` — same data as the home-page `embeddings-health` card)                                                                                                                                                                                         |
| `memories-stats`                                                                              | `/memories`                     | Stats panel: totals by type, recent count, top accessed, superseded count                                                                                                                                                                                                                                                                     |
| `memories-list`                                                                               | `/memories`                     | Browseable record table with type + scope filters                                                                                                                                                                                                                                                                                             |
| `memories-search`                                                                             | `/memories`                     | Search bar consuming `memory_search`; surfaces `degraded` flag when embeddings provider is down                                                                                                                                                                                                                                               |
| `memories-detail`                                                                             | `/memories` (modal)             | Detail view: full content, associations, metadata, superseded-by chain, similar records                                                                                                                                                                                                                                                       |
| `slow-topology`                                                                               | `/plant`, `/interceptors/:name` | Derived guard-hook registry + interlock history (install date, commit link, retrospective correlation); reads only the sweeper's in-process cache, never derives per-request (mt#2602). Second consumer moved from the interlock-history page to the interceptor detail view by mt#4229; the plant board's valve-inventory badge is unchanged |

### Reviewer Bot Status widget

Widget ID: `reviewer-bot-status` (mt#2076). Backend: `src/cockpit/widgets/reviewer-bot-status.ts`. Frontend: `src/cockpit/web/widgets/ReviewerBotStatus.tsx`.

**What it surfaces (14 fields):**

| Field                 | Source                                  | Description                                                                                               |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Health check          | `/health` HTTP probe                    | HTTP status code (200 OK or error); shows how long ago the probe ran so a stale result is visible         |
| In-flight reviews     | `/health` JSON body                     | Real-time count of reviews the service currently has in progress                                          |
| Provider              | `/health` JSON body                     | LLM provider (e.g. `anthropic`)                                                                           |
| Model                 | `/health` JSON body                     | LLM model name (e.g. `claude-sonnet-4-6`)                                                                 |
| Tier 2 enabled        | `/health` JSON body                     | Whether the tier-2 review path is active                                                                  |
| Reviews (24h)         | `reviewer_webhook_events`               | Count of `review_submitted` outcome events in the last 24 h (throughput)                                  |
| Failures (24h)        | `reviewer_webhook_events`               | Count of `failed_at_*` outcome events in the last 24 h; hover to see last error                           |
| Recent tasks          | `reviewer_convergence_metrics.head_ref` | mt# task IDs from the last `N` reviewed PRs (derived from branch name; empty/null head_refs are excluded) |
| Avg latency (24h)     | `review_timing.total_wall_clock_ms`     | Mean wall-clock time per review over the last 24 h                                                        |
| P95 latency (24h)     | `review_timing.total_wall_clock_ms`     | 95th-percentile wall-clock time over the last 24 h                                                        |
| Stale in-flight       | `reviewer_inflight_reviews.acquired_at` | Reviews acquired more than 10 min ago (indicates a stuck worker)                                          |
| Failure rate (24h)    | Computed                                | `failureCount / (reviewCount + failureCount)` over the last 24 h                                          |
| Rate-limit hits (24h) | `review_timing.retry_outcomes`          | Count of `rate_limited` entries across all retry outcome arrays in the last 24 h                          |
| Last webhook          | `reviewer_webhook_events.received_at`   | Relative time of the most recently received webhook event                                                 |

**Anomaly semantics (A1–A4):**

| Code                     | Trigger                                                     | Severity |
| ------------------------ | ----------------------------------------------------------- | -------- |
| A1 — Service unreachable | `/health` probe returned non-200 or timed out (5 s timeout) | Error    |
| A2 — Stale in-flight     | >= 1 review acquired more than 10 min ago                   | Warning  |
| A3 — Failure-rate spike  | > 50% failure rate AND sample >= 5 events in the last 24 h  | Error    |
| A4 — Latency regression  | P95 latency > 120 s in the last 24 h                        | Warning  |

**DB access:** reads four reviewer tables directly via the shared Postgres connection (`getSharedPersistenceService`). The widget degrades gracefully — DB fields become `null` when the DB is unreachable (A1–A4 continue to be computable from the `/health` probe alone). Individual SQL query failures degrade only the affected field(s); the `db` object is still non-null when only some queries fail (e.g. `PERCENTILE_CONT` unsupported on a PG variant causes `avgLatencyMs`/`p95LatencyMs` to be null while all other fields remain populated).

**Query-layer-failure signal (mt#2758):** `db.queryFailureCount` / `db.queryTotalCount` (15 queries per fetch cycle) distinguish "a query failed" from "a query legitimately returned zero rows" — both previously rendered as indistinguishable zeros. The frontend renders an `AnomalyBanner` whenever `queryFailureCount > 0` (amber for partial, `destructive` for every query in the cycle failing). See "Query-layer-failure vs no-data convention" above for the general pattern this widget is the reference implementation of.

**Health endpoint override:** set `MINSKY_REVIEWER_HEALTH_URL` to point at a different host. Default: `https://minsky-reviewer-webhook-production.up.railway.app/health` (the Railway public domain for the `minsky-reviewer-webhook` service).

**Polling interval:** 30 s (backend) / 30 s (frontend TanStack Query `refetchInterval`).

## Ask advancement sweep (mt#2265)

The cockpit daemon runs the **ask advancement sweep**: one pass at boot, then
every 60s (`startAskAdvancementSweeper` in `src/cockpit/sweepers.ts`, domain
logic in `packages/domain/src/ask/advancement.ts`). The sweep advances
`detected` asks that nothing else routed — emission-callsite rows, rows from
crashed processes — and expires stale ones (`detected` older than 7 days;
ephemeral authorization/review requests whose moment has passed).
**`direction.decide` asks are exempt from staleness expiry everywhere** —
they are durable principal decisions, so a stale one is routed to the
operator surface (where it can be declined) rather than silently expired;
the triage script likewise never bulk-expires them. Per-kind
coverage: operator-bound asks (inbox / elicitation-fallback) land `suspended`
and appear on `/asks`; policy-covered asks close with the citation;
subagent/mesh/retriever asks persist as `routed` awaiting a delivery loop
(mt#1570 family). `createAsk` itself persists its route outcome at create
(the sweep is the recovery backstop, not the primary path). Observability:
asks count-by-state on `debug_systemInfo` (`asks` field) — a growing
`detected` count means the advancement path is not running. One-time backlog
triage: `bun scripts/asks-backlog-triage.ts` (dry-run by default,
`--execute` to expire the stale set; `direction.decide` asks are never
bulk-expired).

## Transcript watcher (mt#2320)

The cockpit daemon runs the **transcript watcher** — the primary transcript-capture
mechanism of ADR-017. It attaches a recursive `fs.watch` over
`~/.claude/projects/**/*.jsonl` (`startTranscriptWatcher` in
`src/cockpit/transcript-watcher.ts`) and, on append, ingests the changed
session's new turns through the existing idempotent
`AgentTranscriptIngestService` (via a `SingleFileTranscriptSource` so a single
file ingest is O(1), not a full project scan). An in-flight session therefore
becomes FTS-searchable shortly after its turns hit disk — no session exit, no
manual `transcripts ingest`, no MCP reboot. Existing transcripts are seeded at
start with their tailer offset at EOF (history is owned by the boot sweep,
mt#2051); only post-attach appends are tailed. The shared incremental-read
primitive is `JsonlTailer` (`packages/domain/src/transcripts/jsonl-tailer.ts`),
reused by the Rung-1 live renderer (mt#2232). Ingest dedup is owned by the
service's timestamp high-water-mark, so a missed/dropped FS event is recovered
by the periodic sweep backstop (mt#2321); the watcher fails open (an
unsupported recursive watch logs and no-ops).

**Observability — `GET /api/health` `transcriptWatcher`.** Because the watcher
runs in the cockpit process (unlike `debug_systemInfo`, which is the MCP-server
process), its health is exposed on the cockpit's own `/api/health` endpoint
under a `transcriptWatcher` object:

```jsonc
"transcriptWatcher": {
  "running": true,
  "filesWatched": 12,
  "ingestsTriggered": 34,
  "ingestsSucceeded": 33,
  "ingestErrors": 1,
  "turnsIngested": 410,
  "lastIngestAt": "2026-06-18T20:00:00.000Z",
  "lastErrorAt": "2026-06-18T19:58:00.000Z",
  "activeSessions": [
    {
      "agentSessionId": "abc-123",
      "isSubagent": false,
      "lastEventAt": "2026-06-18T20:00:00.000Z",
      "lastIngestAt": "2026-06-18T20:00:00.000Z",
      "lastTurnsIngested": 3
    }
  ]
}
```

**Security posture.** `/api/health` is unauthenticated, so the payload is
deliberately redacted: it carries **no absolute filesystem paths** (the
`agentSessionId` — the JSONL filename stem — is the only session identifier;
the absolute `jsonlPath` is never exposed) and **no raw error-message strings**
(only an `ingestErrors` count and `lastErrorAt` timestamp; the underlying error
text is emitted to the daemon log surface, not the API). Adding a field here
that could leak a path or internal detail re-opens that disclosure — keep the
redaction when extending it.

**Watchdog fields (mt#2578).** The tray-app supervisor's self-health watchdog
(ADR-014 lifecycle extension) reads two additional top-level fields from
`/api/health` to detect daemon restarts and sustained DB degradation:

| Field                 | Type                   | Semantics                                                                                                                                                                                                                       |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processStartedAtMs`  | `number` (epoch-ms)    | Timestamp when this daemon process started. The tray supervisor compares it across polls; a value change means the daemon restarted (used to detect adopted-daemon restarts not caused by a supervised child exit).             |
| `consecutiveDegraded` | `number` (integer ≥ 0) | Number of consecutive health polls where the DB status was not `"ok"`. The tray uses this as a cross-check; it also maintains its own DB-degraded counter for alert gating. Reset to `0` on the first poll where `db === "ok"`. |

**Redaction note:** both fields are non-sensitive — `processStartedAtMs` is an
epoch-ms integer with no path or identity information; `consecutiveDegraded` is
a small counter. Neither violates the endpoint's unauthenticated-access posture.

## Transcript sweep backstop (mt#2321)

The cockpit daemon also runs the **transcript sweep backstop** — the recovery
layer behind the watcher (mt#2320), per ADR-017's watcher-primary +
sweep-backstop design. On a configurable cadence (`startTranscriptSweepBackstop`
in `src/cockpit/sweepers.ts`) it runs a full-discovery `ingestAll()` (idempotent /
HWM-gated) followed by the vector-only semantic-embedding backfill
(`index-embeddings`), run off the critical path and fail-open — a missing or
failing embedding provider does not crash the sweep. It recovers what the watcher
can miss: dropped/coalesced FS events, sessions that completed while the daemon
was down, sessions predating the watcher's attach, and stale/missing embeddings.

**Cadence.** Default 30 minutes (heavier than the prod-state sweeper because a
full `ingestAll` re-discovers every session). Externally configurable via the
`MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS` env var (positive-integer milliseconds;
invalid values fall back to the default with a warning).

**Observability — `GET /api/health` `transcriptSweep`.** Like the watcher, the
sweep runs in the cockpit process, so its health is on the cockpit's own
`/api/health` — NOT `debug_systemInfo`, which runs in the MCP-server process and
would read zero for cockpit-process state:

```jsonc
"transcriptSweep": {
  "sweepsRun": 3,
  "sessionsIngested": 41,
  "sessionsErrored": 0,
  "embedRuns": 3,
  "lastSweepAt": "2026-06-19T22:00:00.000Z",
  "lastErrorAt": null
}
```

Same redaction posture as the watcher: counts + ISO timestamps only — no
absolute paths, no raw error-message strings (the unauthenticated-endpoint
disclosure constraint).

## Scheduled follow-up sweeper (mt#2322)

The cockpit daemon hosts a **general recurring-job scheduler facility** whose
first consumer is the **scheduled-follow-up** primitive — mt#2322, the
remaining scope of parent mt#2234 after mt#2320/mt#2321/mt#2381 shipped the
watcher, sweep backstop, and ADR-019 seam re-cut respectively. There is no
separate scheduler abstraction to build: `createIntervalSweeper` (above) IS
the general recurring-job primitive — it is already proven general by every
sweeper in this file (ask advancement, prod-state, topology, transcript
backstop, dispatch watchdog, deploy.smoke), and the follow-up sweep
(`startFollowUpSweeper` in `src/cockpit/sweepers.ts`) is simply its newest
registrant.

**The one-shot primitive.** A follow-up is a `scheduled_follow_ups` DB row
(`message`, `dueAt`, `status`, optional `relatedTaskId`/`relatedSessionId`) —
storage-backed rather than an in-memory `setTimeout`, so it survives a daemon
restart between creation and its due time (sweeper-not-durable-queue per
`decision-defaults.mdc §Reliability`: the DB row is the durable state, the
sweep is the reconciliation loop). `FollowUpService`
(`packages/domain/src/scheduler/follow-up-service.ts`) owns create/list/
cancel/fireDue; `fireDue()` is idempotent — it status-guards its UPDATE to
`pending` rows only, so overlapping ticks or a sweep re-run can never
double-fire a follow-up.

**Cadence.** Every 60 seconds — a follow-up's "fires locally at its scheduled
time" contract only needs local precision, matching the meta-watchdog's own
cadence.

**HTTP surface — `/api/follow-ups`** (`src/cockpit/routes/follow-ups.ts`):

```
GET  /api/follow-ups            — list, optional ?status=pending|fired|cancelled|failed
POST /api/follow-ups            — create: { message, dueAt (ISO-8601), payload?, relatedTaskId?, relatedSessionId? }
POST /api/follow-ups/:id/cancel — cancel a still-pending follow-up
```

**Observability.** No dedicated tracker — the sweep is a `createIntervalSweeper`
registrant like every other sweep in this file, so its liveness
(lastAttemptAt/lastSuccessAt/lastErrorAt/consecutiveFailures) is already
covered generically by the shared sweep-liveness registry on `GET /api/sweeps`
(next section) under the name `"scheduled follow-ups"`. Those fields cover the
SCHEDULING layer only. **As of mt#4412 this sweep also reports a DOMAIN
outcome** — `ok` is false when a due follow-up failed to fire — so whether its
work is succeeding is visible on `/api/sweeps` beside its scheduling fields.
(mt#3684 added the channel and left adoption optional; mt#4412 made it
mandatory, so "migrating each sweep onto it is separate work" no longer
applies — every registrant now declares one.)

## Sweep-liveness registry + meta-watchdog (mt#2894)

Every periodic sweep in this file is built on the shared `createIntervalSweeper`
factory (`src/cockpit/sweepers.ts`). mt#2625 hardened that factory against a
single tick hanging or throwing (per-tick timeout, watchdog force-release,
last-resort catch — see the factory's own docblock). mt#2894 closed a
DIFFERENT failure class the per-tick hardening structurally cannot cover: the
underlying `setInterval` handle itself getting silently dropped or wedged
while the daemon process stays alive — evidenced by a 2026-07-16 incident
where two independent sweeps (prod-state, dispatch-watchdog) stopped
attempting ticks within ~5 minutes of each other with no per-tick error to
explain it.

**Liveness registry.** `createIntervalSweeper` now registers every sweep in
an in-process registry tracking `lastAttemptAt` (every time the interval
callback fires, whether or not the tick that follows succeeds),
`lastSuccessAt`, `lastErrorAt`, and `consecutiveFailures`. Exposed via:

```
GET /api/sweeps
```

```jsonc
{
  "sweeps": [
    {
      "name": "prod-state refresh",
      "intervalMs": 600000,
      // Scheduling layer: did the timer fire, and did the callback return?
      "lastAttemptAt": "2026-07-17T13:00:00.000Z",
      "lastSuccessAt": "2026-07-17T13:00:00.050Z",
      "lastErrorAt": null,
      "consecutiveFailures": 0,
      "reinits": 0,
      "metaRestarts": 0,
      // Domain layer (mt#3684): did the sweep's WORK succeed?
      // DECLARATION (mt#4412) — static, set at registration. True for every
      // registrant: both registration paths oblige their sweeps to state an
      // outcome, so this is assertable the moment the registry is populated.
      "declaresDomainOutcome": true,
      // OBSERVATION — has this sweep actually reported one YET? Flips on the
      // first tick that completes and returns. Distinct from the field above
      // on purpose; see below.
      "reportsDomainOutcome": true,
      "lastDomainSuccessAt": "2026-07-17T13:00:00.050Z",
      "lastDomainFailureAt": null,
      "consecutiveDomainFailures": 0,
    },
  ],
}
```

**The two groups of fields answer different questions, and reading one for the
other is what made a 13-hour outage invisible (mt#3684).** The scheduling
fields report that the timer fired and the tick function returned. Because the
factory's `tick` contract asks each sweep to apply its own fail-open try/catch,
a tick that failed still RETURNS — so on 2026-08-06 this endpoint showed
`lastSuccessAt` one minute old and `consecutiveFailures: 0` while the
prod-state sweep had been failing every tick for 13 hours. That reading was
correct about scheduling and silent about the outage.

A tick therefore ALSO reports its own outcome (returns `{ ok: boolean }`),
recorded in the `*Domain*` fields. **mt#3684 made that optional and mt#4412
made it mandatory** — `IntervalSweeperOptions.tick` returns
`Promise<SweepTickResult>` and `void` is no longer assignable, because 15 of 17
registrants had taken the optional default, so for 88% of them this endpoint
could not tell a working sweep from one whose tick caught its own error and
returned. The self-scheduling path (`registerSelfSchedulingSweep`, below) is the
other way into this registry and has no tick at all; its handle's
`noteSuccess`/`noteFailure` record a domain outcome, while `noteProgress`
remains scheduling-only and deliberately does not.

**`declaresDomainOutcome` and `reportsDomainOutcome` are not the same field, and
the difference is load-bearing.** The first is a static DECLARATION fixed at
registration — every registrant is obliged to state an outcome, so the invariant
is assertable the moment the registry is populated. The second is a runtime
OBSERVATION: it starts `false` and flips the first time a tick actually
completes and returns. So a registrant reads `reportsDomainOutcome: false`
while it is merely waiting for its first tick (up to 60 minutes for `topology`),
and also when its tick never settles at all — an abandoned tick never returns,
so it can never flip the flag. **Neither is a defect**, which is why "has it
reported yet" cannot be used as the health check; use `declaresDomainOutcome`
for the invariant and the `*Domain*` timestamps for the actual outcome. When
`reportsDomainOutcome` is `false`, read the three `*Domain*` fields as
meaningless rather than healthy.

What a sweep reports is its OWN result, never a blanket `ok: true` — a uniform
success reproduces the original defect in a shape that reads as covered. The
line each sweep draws is **"cannot do the work" (a domain failure) versus
"nothing to do" (healthy)**: a missing dependency is the first, an empty pass is
the second. `reinits` counts a sweep's own bounded self re-init (below);
`metaRestarts` counts a meta-watchdog-triggered force-restart. A domain failure
deliberately drives neither: re-init recovers a wedged tick, and mt#3682
established that restarting the interval does nothing for a failure below the
sweep.

This is a SEPARATE endpoint from `/api/health`'s per-domain sweep trackers
(`prodStateSweep`, `transcriptSweep`, `dispatchWatchdogSweep`). Those cover 3
of the **17** registered sweeps (measured live 2026-08-22; this said 11 before
mt#4412 and had drifted). The other 14 — ask advancement, stale-ask close,
short-id map refresh, ask-state refresh, topology, deploy.smoke, scheduled
follow-ups, conversation presence, conversation title, conversation summary,
guard-events sweep backstop, interceptor-aggregates, stdio-log rotation, and
the self-scheduled principal-channel poll — have no domain-specific tracker of
their own, which is why the domain fields above exist on the shared registry
rather than being deferred to a per-sweep tracker that may not exist. Settle the
count with
`curl -s localhost:3737/api/sweeps | jq '.sweeps | length'`.

**`/api/health` carries the AGGREGATE, and only since mt#4384.** Its `sweepLiveness`
block reports `abandonedTicksOutstanding`, the sweeps holding those ticks,
`registrants`, and the declaring/reporting counts — enough that a reader cannot reach
"healthy, just hasn't finished" from a wedged sweep. Before mt#4384 this endpoint never
read the liveness registry at all, so abandonment could not appear there **by
construction**: the three blocks it did carry are DOMAIN trackers, and an abandoned tick
never completes, so it produces no domain outcome for them to report. On 2026-08-21
`prodStateSweep` read `lastSuccessAt: null, lastErrorAt: null, consecutiveFailures: 0`
while `/api/sweeps` showed nine sweeps wedged with guards held. **Per-sweep detail still
lives on `/api/sweeps`**, which the payload names in `authoritativeSurface`.

### A restarted daemon takes up to 15 minutes to look healthy

**At 12 minutes it looks identically wedged, and that is the single most misleading
reading this subsystem produces.** mt#4335's abandoned-tick hard release fires at
`DEFAULT_TICK_TIMEOUT_MS × ABANDONED_TICK_HARD_RELEASE_MULTIPLIER` = 5 min × 3 = **15
minutes**. Until it does, a boot tick that wedged is still outstanding, so the sweep
shows a tick open with `lastSuccessAt: null` — indistinguishable from a restart that
accomplished nothing.

Measured 2026-08-21: the boot tick was abandoned at 17:52:09, the hard release fired at
18:07:09 **exactly**, and the next tick succeeded at 18:07:09.248Z. Someone checking at
12 minutes concluded the restart had failed, and that reached the principal as an
incident before being corrected.

**So: wait past `tickTimeoutMs × 3` before judging a restart**, and read `/api/sweeps`
(or `/api/health`'s `sweepLiveness`) rather than a domain tracker while you wait —
`abandonedTicksOutstanding` falling to zero is the signal that recovery actually
happened. Two further cautions from the same family: a restart is not reliably the
remedy at all (mem#1178 records an occurrence that self-cleared with none), and
`minsky cockpit restart` DOES work under the tray despite an older note to the contrary
(re-measured 2026-08-21).

**Bounded re-init.** After `REINIT_FAILURE_THRESHOLD` (3) consecutive tick
failures (timeout or unexpected throw — NOT a domain-level failure the
tick's own fail-open try/catch already absorbed), the sweep logs loudly and
force-restarts its own interval, resetting the failure streak.

**Meta-watchdog ("sweep of sweeps").** `startSweepMetaWatchdog` (started
alongside the six sweepers in `src/commands/cockpit/start-command.ts`) scans
the liveness registry on its own cadence (default 60s) and force-restarts
any sweep whose `lastAttemptAt` is stale by more than 2x its own cadence —
recovering a dropped/wedged timer with no tick-level signal to react to.
Deliberately scheduled on a self-rescheduling `setTimeout` CHAIN rather than
its own `setInterval`, since the failure class it recovers from implicates
the shared interval-scheduling layer; sharing that primitive for the
watchdog itself would risk it dying alongside the thing it watches.

**The reach of all of this is exactly the REGISTRANT SET (mt#4185).** The
meta-watchdog iterates the liveness registry, so a loop that is not in the
registry is not merely unrecovered — it is unobserved: absent from
`/api/sweeps`, never scanned, never restarted. Membership is therefore the
first question to ask of any long-lived loop in this daemon, ahead of any
question about its failure modes.

Two ways in, and no third: `createIntervalSweeper`, which registers as a side
effect of scheduling the tick; and `registerSelfSchedulingSweep`, for a loop
that schedules itself and hands back only the RECORDING half — it calls
`noteProgress()` where it demonstrably advanced, supplies its own `restart`,
and declares a PROGRESS BUDGET in place of a cadence (`selfScheduled: true` in
the payload says which of the two `intervalMs` means). `custom/require-registered-cockpit-loop`
fails the build on a new `start*` export that runs a flag-shaped `await` loop
through neither.

**A registrant that has reported NOTHING is still evaluated (mt#4206).** Every
entry carries `registeredAt`, and for a self-scheduling participant the stall
predicate falls back to it when `lastAttemptAt` is still null — so a loop that
parks BEFORE its first progress call is flagged rather than skipped forever. The
skip is retained for an interval sweep, where the null window is
millisecond-scale because the registry drives the tick; treating it as a stall
there would restart every healthy sweep at boot. `registeredAt` also makes
"registered, never reported" a dateable reading on `/api/sweeps` instead of an
inference from a bare null.

This paragraph exists because its absence was load-bearing. Until mt#4185 the
enumeration below listed only failure modes, so a NON-REGISTRANT loop was in
neither the covered nor the not-covered set — outside the enumeration
entirely, which is why repeated `Does NOT cover` audits never surfaced it
while `startPrincipalChannelPoller` sat parked for ~44 hours (mt#4183). When
writing a `Does NOT cover`, state the mechanism's MEMBERSHIP boundary, not
only the failures it handles.

**What this does NOT cover:** the daemon process dying (tray supervision,
mt#2786, owns that) or the meta-watchdog's own `setTimeout` chain dying
(total timer death) — that residual is detectable via `/api/sweeps`
going stale plus the consumer-side staleness banners
(`inject-prod-state.ts` / `inject-dispatch-watchdog.ts`), with recovery
falling to tray/operator supervision. For a self-scheduling registrant it
also does not clear a park in an await that ignores the abort signal: the
stall is detected, logged and counted, but only the participant's own
per-await bounds can settle it (mt#4183 owns the poller's). See mt#2894's
spec for the full Covers/Does NOT cover enumeration, and mt#4185's for the
self-scheduling seam's.

**Daemon rotating file log.** Investigating the 2026-07-16 incident found
that `log.warn` — the exact call the factory above uses for every tick
timeout/throw/watchdog event — was a silent no-op under the cockpit
daemon's default logger mode (`@minsky/shared/logger`'s HUMAN mode without
`ENABLE_AGENT_LOGS`), so none of this observability ever reached a log file
even where the daemon's raw stdout/stderr WAS captured (the tray supervisor
and launchd both redirect it, unbounded, to
`~/.local/state/minsky/logs/cockpit-{stdout,stderr}.log`). `src/cockpit/
daemon-file-log.ts`'s `installDaemonFileLogging()` (called first, before any
sweeper starts, in the `cockpit start` action handler) fixes both gaps: it
forces `ENABLE_AGENT_LOGS=true` for the daemon process and attaches a
size-bounded, rotating (winston's built-in `maxsize`/`maxFiles`) JSON+
timestamp File transport at `~/.local/state/minsky/logs/cockpit-daemon.log`,
independent of which of the three daemon-launch paths (tray, launchd, or a
bare manual start) is in use.

**Stdio-redirect log rotation (mt#3298).** The raw stdio capture files the
supervisors write — `~/.local/state/minsky/logs/cockpit-{stdout,stderr}.log`,
redirected by the tray supervisor's `open_log()` and the launchd plist's
`StandardOutPath`/`StandardErrorPath` — previously had NO rotation and
accumulated 6.2 GB. `src/cockpit/stdio-log-rotation.ts` bounds them with an
in-daemon sweep (`startStdioLogRotationSweeper`, started immediately after
`installDaemonFileLogging()` in the `cockpit start` handler; liveness visible
as `stdio-log rotation` on `/api/sweeps`): **50 MB cap per stream, 2 rotated
files retained per stream (`.1` newest), 60 s check cadence plus a boot
tick** — worst case ~300 MB on disk across both streams. Rotation is
copy-tail-then-truncate (logrotate's `copytruncate` pattern): the daemon
cannot reopen the supervisor-owned inherited fds 1/2, so rename-based
rotation (newsyslog-style) would leave those fds writing to the renamed
inode forever. Both supervisors open the files O_APPEND, so truncating the
live file in place cleanly resets the write position; only the last 50 MB is
copied into `.1`, so a single boot tick bounds even a multi-GB file left by
a previous run. The documented copytruncate race (raw stdio written between
copy and truncate is lost) is accepted — `cockpit-daemon.log` above is the
primary operational record.

One-time reclaim record (mt#3298 SC4): on 2026-07-29, operator-authorized
via ask#6348 ("Truncate both"), both files were truncated in place while the
daemon ran — `cockpit-stdout.log` 4,579,567,871 B and `cockpit-stderr.log`
1,976,335,179 B → 0 B; the logs directory went 6.2 GB → 91 MB (6,261 MB
reclaimed) with no daemon downtime (`/api/health` verified after).

## Slow-clock topology sweeper (mt#2602)

The cockpit daemon runs the **slow-clock topology sweeper**
(`startTopologySweeper` in `src/cockpit/sweepers.ts`): one pass at boot, then
hourly, mirroring `startProdStateRefreshSweeper`'s producer/consumer split
(mt#2506). Each pass:

1. Resolves the repo root (`findRepoRoot`, `web-dist.ts`) and lists
   `.claude/hooks/` and `.minsky/hooks/` (both, deduped — the mt#2304
   compile-pipeline migration may be pre-merge, mid-flight, or complete).
2. Runs a single bounded, read-only `git log --reverse --diff-filter=A
--name-only -- .claude/hooks .minsky/hooks` (10s timeout, 4MB max-buffer)
   to find each hook file's original install commit — pure derivation logic
   in `src/cockpit/topology-derivation.ts`, impure I/O in
   `src/cockpit/topology-cache.ts`.
3. Queries `retrospective.fired` system events (mt#2537) and correlates them
   to install commits by task ref (exact) or time proximity (nearest
   preceding, within 14 days).
4. Writes the result to an in-process cache; the `slow-topology` widget's
   `fetch()` only ever reads this cache — no per-request git subprocess or
   DB query.

Fail-open at every step: a missing repo root, unreadable hook dirs, a failed
git subprocess, or an unreachable DB each degrade to honest `null`/`unknown`
fields (or, for a total failure, leave the last-good cache in place) rather
than fabricating data. The widget payload's `status` field distinguishes
`"pending"` (no successful sweep yet) from `"ready"`.

## Operator dev loop

Dev mode (recommended for active UI work):

```bash
minsky cockpit start --dev --port 3737
```

Starts Express API + Vite dev middleware on a single port. Frontend changes hot-reload via Vite HMR; API routes are served by Express as normal. For server-side auto-restart, wrap with `bun --watch`:

```bash
bun --watch run src/cli.ts cockpit start --dev --port 3737
```

Production mode (pre-built bundle):

```bash
bun run cockpit:build && minsky cockpit start --port 3737
```

When the daemon is run via the **cockpit tray** (the canonical supervisor, ADR-014), this `cockpit:build` step is automatic: the tray rebuilds the bundle at startup if source is newer than `dist/`, and watches `src/cockpit/web/**` for changes while running (mt#2297). Operators running through the tray never need to invoke `cockpit:build` by hand. The auto-rebuild is gated on a source checkout being present — a packaged/no-source install serves the bundle shipped with the app.

## Bind, auth, and CSP posture (mt#2538)

The daemon binds `127.0.0.1` (loopback) by default (`src/commands/cockpit/start-command.ts`).
An explicit `--host <host>` opt-in is required to bind any other interface; doing so logs a
one-line warning naming the exposure (cockpit data — tasks, sessions, transcripts, live events —
plus the command surface become reachable from that interface, e.g. the whole LAN for a bare IP
or `0.0.0.0`).

**Loopback bind alone is not a sufficient auth posture.** Any local process of any user on the
machine can reach loopback, DNS-rebinding can drive a victim browser at `localhost`, and the Rung
2A driven-session WS channel (mt#2750) needs a token model regardless. So the daemon also enforces:

- **Bearer token** (`src/cockpit/auth.ts`) — a random token generated on first boot and persisted
  at `~/.local/state/minsky/cockpit-token` (mode `0600`), reused across restarts. Every
  non-GET/HEAD/OPTIONS request must carry it, either as `Authorization: Bearer <token>` or via the
  `minsky_cockpit` cookie (`HttpOnly`, `SameSite=Strict`, no `Secure` — the daemon is plain HTTP on
  loopback). The cookie is minted automatically on the first GET, so the SPA's same-origin
  mutation fetches work with zero URL/localStorage plumbing. A `?token=<t>` query-param bootstrap
  is also accepted on any GET (validates, sets the cookie, redirects to strip the param) for a
  future non-loopback opt-in consumer.
- **Read-only GET/SSE surfaces are exempt from the token check.** The loopback bind already
  restricts them to the local machine, and plumbing the token to every GET consumer (the tray
  Rust supervisor's `/api/health` poll, the chrome-devtools-mcp dev canary, curl operators) is
  disproportionate at this tier. The Rung 2A WS channel (mt#2750, see below) DOES require the
  token — it is remote command execution, not a read-only surface.
- **Host-header allowlist** (DNS-rebinding defense) — every request's `Host` header must resolve
  to `localhost`, `127.0.0.1`, `::1`, or the configured `--host` value; anything else gets `403`.
  This is what stops an attacker-controlled DNS name that resolves to `127.0.0.1` from reaching
  the daemon under its own `Host` value.
- **Content-Security-Policy** — set on every GET/HEAD response (`src/cockpit/csp.ts`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'`. `--dev` mode (Vite HMR) uses a
  relaxed variant (`'unsafe-inline' 'unsafe-eval'` on `script-src`) since Vite's dev client and
  esbuild's dev transform rely on inline/eval'd script execution the pre-built prod bundle never
  needs.
- **No permissive CORS.** There is no `cors` middleware and no `Access-Control-Allow-Origin`
  response header anywhere in `server.ts` — that absence IS the policy (same-origin only). A
  cross-origin mutation additionally fails an explicit `Origin` check as defense in depth for
  non-browser HTTP clients that set `Origin` manually (browsers already can't get a cross-origin
  `fetch()` to succeed here, and the `SameSite=Strict` cookie is never sent cross-site regardless).

Scope: this posture covers the **local** cockpit daemon only. The Railway-deployed
`services/cockpit/src/server.ts` is a separate entrypoint that binds `0.0.0.0` deliberately for
the platform proxy. Because both entrypoints share the same `createCockpitServer()` factory, the
Railway entrypoint passes `isPublicDeployment: true` (`CockpitServerOptions`), which skips the
Host-header allowlist and the bearer-token/cookie mutation-auth for that deployment — its
incoming `Host` header is a Railway-assigned public hostname that could never satisfy the
loopback-only allowlist. The CSP header and the no-CORS policy are additive/response-only, so
they still apply to the Railway deployment too. The Rung 3 cloud→local relay channel (mt#2238)
owns its own, distinct auth surface for that separate concern.

### The public deployment is passkey-gated (mt#4023)

**`isPublicDeployment: true` does not mean "no auth."** It did until mt#4023, and the
consequence was measured: on 2026-08-11 an unauthenticated `GET /api/tasks` against
`cockpit-preview-production.up.railway.app` returned 500 live production tasks, and
`/api/cockpit/session-film/sessions` returned 49 conversations. The flag still turns off the two
loopback-shaped defenses above, but it now turns ON a WebAuthn passkey gate in their place.

- **Deny by default.** `requirePasskeySession` (`src/cockpit/passkey-auth.ts`) rejects every
  request without a valid session cookie with `401`. The public-path list is CLOSED — `/api/health`,
  `/api/auth/*`, and the SPA shell plus its static assets — so a route added later is gated on
  arrival rather than by anyone remembering to add it.
- **`/api/health` stays public**, because the Railway healthcheck and the mt#1302 post-deploy
  monitor both poll it unauthenticated.
- **First-run enrollment is once-only.** Enrolling a passkey is permitted without a session only
  while ZERO passkeys exist; after that it requires an existing session. That is what makes the
  gate a gate rather than a race for whoever loads the URL second.
- **Sessions are stored, not signed-stateless** (`cockpit_auth_sessions`), so revoking one is a
  row delete with no secret to rotate. The cookie carries the `__Host-` prefix under TLS.
- **Relying-party id.** `up.railway.app` is on the Public Suffix List, so the rpID must be the
  full deployment hostname; `MINSKY_COCKPIT_RP_ID` / `MINSKY_COCKPIT_ORIGIN` override it. Moving
  to a custom domain changes the rpID and therefore requires re-enrolling every passkey — a
  credential is bound to the rpID it was created under.
- **Fail-closed.** If the auth tables are missing or the database is unreachable, the gate returns
  `503` and keeps denying; it does not fall open. Verified by booting the deploy entrypoint before
  migration `0094` was applied: every data route still answered `401`.

**Every cockpit answers `GET /api/auth/status`**, including the local daemon, which reports
`{ gated: false }`. That route must never be left unmounted: the SPA catch-all answers unmatched
GETs with `index.html`, and an HTML `200` is indistinguishable from a real answer to the client,
which fails closed on it — leaving it unmounted locally would lock the local daemon out of itself.

The local (`!isPublicDeployment`) path is otherwise unchanged: no passkey middleware is mounted,
and the Host allowlist plus bearer/cookie mutation auth apply exactly as described above.

### Published conversation share links (mt#4024)

**The one hole in deny-by-default, and it is operator-punched, one conversation at a time.**
The point is handing a single conversation to a single person — "take a look at this" — without
giving them the cockpit or an account. Nothing becomes public by deploying this.

**How to publish.** Open a conversation (`/conversation/:id`) and press **Share**. That opens a
confirmation, and the confirmation is the control, not a courtesy: it names the conversation, how
many turns it has, and when they happened, and it states that everything in the conversation
becomes readable — file contents, command output, tool results, anything an agent pasted in. The
click that opens it mints nothing. **If the confirmation cannot read the conversation, it refuses
to publish** rather than offering a button beside "could not read" — a confirmation that cannot
say what becomes public is not one.

Minting returns a URL of the form `/s/<token>`. **That is the only time the token is ever
readable** — the database stores `sha256(token)`, so a lost URL cannot be recovered, only revoked
and re-minted.

**What the safety actually rests on, in order of how much each does:**

1. **The operator publishes explicitly**, one conversation at a time, behind the confirmation above.
2. **The credential-scrub gate** refuses any transcript ingested before `CREDENTIAL_SCRUB_CUTOFF_ISO`,
   at BOTH publish and render. Re-checking at render matters: the gate is a property of the
   transcript row, so a link minted while it passed stops serving if the row later does not.
3. **Revocation is real** — a `revoked_at` flip, no secret to rotate, effective on the next request.

**The scrub gate does NOT make publishing safe on its own, and the design does not pretend it
does.** It matches credential PATTERNS. It does nothing about PII, customer data, private file
contents, or anything else sensitive-but-unpatterned that an agent read into a transcript —
exactly the categories ADR-025 names as the reason the transcript archive bucket must stay
private, and the class mt#3850 records live secrets reaching transcripts through. That is why
step 1 exists and why the confirmation says so in as many words: **read the conversation before
you publish it.**

**What a reader gets.** `/s/<token>` renders that one conversation read-only, with no cockpit
navigation, no mutation affordances, and no path to any other entity. It mounts as a SIBLING of
`AuthGate` and `App` (`src/cockpit/web/main.tsx`) rather than a route inside them, so a page whose
whole purpose is being readable without an account cannot have a sign-in screen rendered over it,
and never mounts SSE or widget polling that would `401` on every tick. It reads exactly one
endpoint and passes an EMPTY entity index — every link it could otherwise render points at a
cockpit route the reader has no session for.

**410 vs 404 is deliberate, and it is for the reader.** A revoked token answers `410 Gone` and
serves no content; an unknown token answers `404`. Someone holding a link that used to work needs
to know it was turned off rather than mistyped, and guessing a 256-bit token is not a threat model.
A transcript that stops passing the scrub gate answers `422`.

**The allow-list stays closed.** `isPublicPath` exempts exactly one new data route,
`/api/shares/public/`. Mint, list and revoke (`/api/shares`) stay gated like everything else —
publishing one conversation opens nothing else, which `conversation-shares.test.ts` pins by
asserting `/api/tasks` and `/api/shares` still `401` while a share is live.

**Never indexed.** The server sets `X-Robots-Tag: noindex, nofollow, noarchive` on both the share
page and its JSON, and the SPA shell carries the matching `<meta name="robots">` so it is in the
HTML a crawler receives before any JavaScript runs. The precedent is ChatGPT's shared links turning
up in search results in August 2025. Note the limit: `noindex` is a request that well-behaved
crawlers honor. It is not access control — the token is.

**The inventory (`/shares`)** answers "what is readable by anyone with a link right now."
**Revoked shares stay listed**, dimmed and labeled with their revocation time, rather than
disappearing — confirming "I turned that off" is what an operator opens the page to do, and a row
that vanishes leaves them unable to. The header counts **live shares only**, and a revoked row
carries no revoke control. Last-access time is what makes the page an exposure readout rather than
a receipt: a link nobody has opened in months is a revocation candidate, and one opened after you
thought the reader was done is worth noticing.

Verification: `bun scripts/verify-conversation-share.ts [--url <base>] [--conversation <id>]` mints
a link, reads it with no session, revokes it, and asserts the `410`. Against a gated deployment it
additionally needs `--cookie` from a signed-in browser, since a passkey ceremony cannot be run
headlessly; against a local daemon it reads the bearer token from
`~/.local/state/minsky/cockpit-token` itself.

## Driven-session host and WS channel (Rung 2A, mt#2750)

`src/cockpit/driven-session-host.ts` spawns the **genuine `claude` binary**
as a managed child of the LOCAL cockpit daemon (never the Railway
`isPublicDeployment` entrypoint — see the Bind/auth section above):

```
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages [--dangerously-skip-permissions]
```

cwd set to the target workspace. Stdout is parsed defensively as
newline-delimited stream-json events (the upstream event schema is thin —
anthropics/claude-code#24594 / #24596). A daemon-side
`DrivenSessionRegistry` tracks each spawned session — keyed by a spawn-time
local id (used by the WS route, addressable before the child's `init` event
can possibly arrive) with the harness `init` session id recorded as a
secondary index once observed.

Endpoints (`src/cockpit/routes/driven-sessions.ts`, mounted only when
`!isPublicDeployment`):

| Path                              | Method | Purpose                                           |
| --------------------------------- | ------ | ------------------------------------------------- |
| `/api/driven-session`             | POST   | Spawn a driven session; returns its local id      |
| `/api/driven-session/:id/stop`    | POST   | Graceful stop (close stdin, SIGTERM fallback)     |
| `/api/driven-session`             | GET    | List app-started sessions (registry snapshot)     |
| `/api/driven-session/turn-active` | GET    | "Is any session mid-turn" signal (mt#3048, below) |
| `/api/driven-session/:id/ws`      | WS     | Bidirectional event/input channel (below)         |

**Turn-active signal (mt#3048).** `GET /api/driven-session/turn-active`
returns `{ active: boolean, activeSessionIds: string[] }` — a cheap,
in-memory scan of the registry for any session whose LATEST observed event
is not yet a terminal `result`/`minsky_exit` event (a record with no live
actuator — any terminal status, or `reconnecting` — is never mid-turn). This
is the pre-restart gate the cockpit-tray watcher's backend-source watcher
(mt#2299, `cockpit-tray/src-tauri/src/watcher_backend.rs`) queries before a
hot-reload daemon restart: if a turn is active, the restart is deferred for
a bounded grace period (`TURN_ACTIVE_GRACE`, 60s, polled every
`TURN_ACTIVE_POLL_INTERVAL`, 5s) and then proceeds regardless — never
indefinitely, since a driven session can sit idle between turns for
hours-days. The mt#3038 resume machinery (advisory lock, `claude --resume`,
interruption-notice injection) recovers the interrupted turn when a restart
does land mid-stream. The query fails OPEN on any error/timeout so a broken
or slow signal endpoint never blocks the watcher's restart.

The WS channel (`src/cockpit/driven-session-ws.ts`) attaches to the
daemon's underlying `http.Server` `"upgrade"` event via the `ws` package
(`{ noServer: true }` + `wss.handleUpgrade`) — WS upgrades bypass Express's
request pipeline entirely, so this is a separate attach point wired from
`src/commands/cockpit/start-command.ts` rather than mounted on the Express
app. It replays the session's buffered event log on connect, streams new
events live, and forwards client frames to the child's stdin as stream-json
user-message turns (multi-turn — the child process stays alive across
turns). Every upgrade is validated against the SAME mt#2538 bearer
token/cookie and Host allowlist the mutation-auth middleware enforces
(`isValidCockpitAuth`/`isHostAllowed`, shared, not reinvented) — an
unauthenticated or disallowed-Host upgrade never completes the handshake.

Permission posture is an explicit, logged parameter
(`bypassPermissions` | `default`; default `bypassPermissions` —
`--dangerously-skip-permissions`, since Rung 2A ships no permission-prompt
UI). If an org policy blocks that flag, the child exits immediately and the
host surfaces a readable `minsky_error`/`minsky_exit` event on the channel
rather than hanging.

Nested-scope note: the spawned `claude` child inherits the operator's MCP
config and may call back into Minsky MCP tools mid-turn. The cockpit daemon
and the Minsky MCP server are separate OS processes reached over
stdio/HTTP by the child — there is no in-process loop; a `tool_use`/
`tool_result` pair is just another pair of forwarded events to this host.

Out of scope for Rung 2A (deferred to later rungs): SPA rendering of the
channel (Rung 2B), launch-from-task UX (Rung 2C), cost readout (Rung 2D),
a raw PTY/xterm.js terminal view, and the cloud relay (Rung 3, mt#2238).

## Daemon lifecycle and tray

- `cockpit-tray/` — Tauri v2 menu bar app
- [ADR-014](adr-014-cockpit-daemon-lifecycle-ownership.md) — daemon lifecycle ownership (tray-app supervisor; mt#2241)
- Bundle auto-rebuild (mt#2297): the tray keeps the served production bundle fresh — a startup pre-flight rebuild (when `src/cockpit/web/**` is newer than `dist/`) plus a runtime filesystem watcher that rebuilds on source changes (excluding `dist`/`node_modules`/`.git`). A "Last build" line in the tray menu shows when the bundle last refreshed; build failures surface there (serving the prior bundle on a runtime failure, refusing to spawn when there is no bundle at all). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Bundle auto-rebuild_.
- Backend auto-restart (mt#2299): the **server-side** complement to the bundle rebuild. The widget registry and route table load at process start, so when backend source (`src/cockpit/server.ts`, `widget-registry.ts`, `widgets/**`, `config.ts`, `types.ts`) changes, the running daemon is stale (new widgets return `Widget not found`) until it restarts. The daemon spawns from source (`bun run src/cli.ts`), so a plain process restart picks up backend changes with no build step. The tray (a) restarts an **adopted** daemon at startup if backend source is newer than the daemon's start time (the originating 2026-06-04 8-day-stale case), and (b) watches `src/cockpit/**` (excluding `web/**`, which the mt#2297 rebuild path owns) and restarts the daemon on a debounced backend change. A "Daemon uptime" line shows how long the daemon has run + the source mtime it was started against, so operators can confirm currency at a glance; a crash-loop on restart (e.g. a syntax error) surfaces the stderr tail in the status line instead of a silent "stopped". Operators never need to manually `kill <pid>` or know that backend changes require a restart (caveat: restart/stop of an _adopted_ daemon depends on `lsof`/`ps` availability + a killable holder; otherwise the tray surfaces the conflict message rather than killing a foreign listener). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Backend auto-restart_.
- Out-of-process memory ceiling (mt#4105): every poll, the supervisor reads each spawned child's **swap-inclusive** memory and SIGKILLs one over 2048 MB — the same threshold `DEFAULT_MEMORY_CEILING_MB` (`src/mcp/orphan-exit.ts`) gives the in-process watcher, differing only in who runs the check. That difference is the point: mt#3886's ceiling, mt#3764's watchers and the `SIGTERM` handlers are all timers or handlers ON the loop they police, and mt#4099 measured two `mcp start` processes at 48.2 GB and 32 GB with every one of them armed and none of them running (a 3s `sample` put all 2483 main-thread samples in one unbroken JS stack, zero `kevent` process-wide). **A process that has wedged its own event loop cannot be the thing that notices.** Mechanism: `footprint -f bytes -p <pid>` on macOS and `VmRSS + VmSwap` from `/proc/<pid>/status` on Linux — the same two interfaces `packages/shared/src/process-memory.ts` reaches, and for the reason it records: `task_info(TASK_VM_INFO)` cannot read another process without `task_for_pid` (root or the debugger entitlement), so a native binding is not an option for a supervisor measuring its child. SIGKILL rather than SIGTERM because the wedged child's `SIGTERM` handler is JS that never runs. Bound: one `POLL_INTERVAL` (5s). A kill the supervisor ordered is classified `ExitClass::CeilingKill` and respawned WITHOUT counting toward the restart throttle — a SIGKILLed process reports the same exit status as any other signalled death, so the supervisor's own record is the only thing that can tell them apart. **Covers supervised children only**; the stdio-proxy population is mt#4112's, and daemons spawned directly by Claude Desktop have no Minsky supervisor at all.
- mt#2141 — follow-up: evaluate repointing Claude Code at shared HTTP MCP

### Port recovery: displacing a wedged incumbent (mt#4205)

When `cockpit start` cannot bind, it classifies the port holder
(`src/cockpit/port-recovery.ts`). A holder matching **this workspace's** recorded pid+port is a
`recognized-zombie`; a holder that does not — including another workspace's cockpit — is
`unrecognized` and is never terminated.

A recognized holder used to be refused outright unless the operator passed `--force`. That was the
wrong default: every known daemon-wedge mechanism (mt#3039 / mt#3051 / mt#3060 / mt#3682) leaves the
process **alive and still holding the port**, so the refusal turned any wedge into an outage lasting
until a human intervened. It fired on 2026-08-06 and again on 2026-08-16.

The guard now probes before deciding, mirroring the predicate ADR-014's supervisor already uses
(`daemon_core.rs`'s `is_ours`). **Displacement requires a positive finding that nothing answered;
every other outcome preserves the incumbent:**

| Probe result at `GET /api/health`                                                 | Outcome                         |
| --------------------------------------------------------------------------------- | ------------------------------- |
| Answers with `service: "minsky-cockpit"` — **at any status, including 503**       | preserve                        |
| Answers without a `service`, or with a different one                              | preserve (fail-closed, mt#3148) |
| Nothing answers, but the holder's start time contradicts the recorded `startedAt` | preserve (recycled pid)         |
| Nothing answers, start time corroborates                                          | **displace**, then bind         |

A **503 preserves deliberately**: the daemon answers 503 while persistence is unhealthy (mt#2949)
and mt#3638's pool-recycle self-heals it, so reading a degraded answer as absence would kill a live
process for correctly reporting a problem.

The probe targets the host the bind was **attempted** on, and tries both loopback families for a
wildcard or `localhost` bind. `localhost` alone is not safe here: `findPortHolder` identifies the
holder with `lsof -i tcp@localhost`, chosen in mt#3787 because it reaches both families, so it can
name a holder that a single-family probe never reaches — and that miss reads as absence, on the
branch that kills.

`--force` remains the operator override and is now meaningful in both directions: it displaces even
a preserving disposition. It is **not** needed to clear a silent incumbent.

Each displacement emits a `cockpit.port_displaced` system event carrying the displaced pid, command,
port, and whether `--force` was used. It is emitted after the replacement binds, because the guard
runs before this process has any persistence provider — and it is the first daemon-lifecycle event
type in that enum, which is why mt#4154 could not reconstruct the 2026-08-06 outage from
`system_events`: every other type is agent-triggered, so a quiet window meant "nobody was working",
not "nothing happened to the daemon".

## Cross-references

- `src/cockpit/CLAUDE.md` — design vocabulary, engineering standards, IA posture (auto-loaded)
- mt#2538 — daemon security hardening (loopback bind default, bearer-token auth, CSP, no-CORS
  policy — see "Bind, auth, and CSP posture" above); `src/cockpit/auth.ts`, `src/cockpit/csp.ts`
- mt#2750 — Rung 2A driven-session host + WS channel (see "Driven-session host
  and WS channel" above); REQUIRES the bearer token this task introduces;
  `src/cockpit/driven-session-host.ts`, `src/cockpit/driven-session-ws.ts`,
  `src/cockpit/routes/driven-sessions.ts`
- mt#2237 — parent (Rung 2); mt#2230 — umbrella (harness-host ladder)
- mt#2238 — Rung 3 cloud→local relay channel; owns its own distinct auth surface, out of scope here
- Memory `Cockpit stack and design/engineering bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — durable cross-cutting reference
- mt#1143 — Cockpit v0 umbrella
- mt#2149 — embeddings-health overview card (DONE 2026-05-27)
- mt#2150 — Memories page (this doc's `/memories` entry)
- mt#2147 — `EmbeddingsHealthTracker` backend (DONE 2026-05-27)
- mt#2626 — guard-vocabulary alignment: "hook" names the Claude Code
  registration mechanics only; "interlock" is the domain noun used here and in
  UI copy; "weld" survives only as a verb ("welding an interlock"). See
  `src/cockpit/CLAUDE.md` §Vocabulary. The `/plant/weld-history` route was
  renamed to `/plant/interlock-history` as part of this change (breaking,
  local-only cockpit — no external consumers). mt#4229 later absorbed that route
  into `/interceptors`; the VOCABULARY decision is untouched — "interlock" is
  still the plant-UI noun, and the plant board's drill-down link still says
  "interlock history". Only the destination moved.
