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
details (a task at `/tasks/:id`, a transcript session at `/session/:id`, a workspace
session at `/agents/:id`) open as URL-driven tabs in a
working-set strip (`TabBar`, hidden when empty; state in localStorage). The ⌘K command
palette is mounted globally.

Two session id-spaces (mt#2398/mt#2420/mt#1919 — do not conflate): `/agents` and
`/agents/:id` are keyed by the **Minsky workspace sessionId** (`SessionRecord`);
`/sessions` and `/session/:id` are keyed by the **harness agentSessionId** (ingested
transcript). The workspace-session detail page bridges the two — when the workspace
directory resolves to an ingested transcript's cwd, it links to the conversation at
`/session/:agentSessionId` (served by `GET /api/agents/:id`).

## Routes

| Path           | Page           | Purpose                                                                                                                    |
| -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/`            | Home           | Attention digest (full top row) + system-status card grid; the rail is the navigation surface (nav tiles removed, mt#2398) |
| `/agents`      | Agents         | Workspace sessions in flight — rows open the workspace-session detail at `/agents/:id`                                     |
| `/agents/:id`  | Session detail | Workspace-session entity tab — liveness, linked task, recent commits, PR state, conversation link (mt#1919)                |
| `/session/:id` | Session        | Session entity tab — readable conversation view of the transcript (mt#2374; supersedes the interim `/conversation` host)   |
| `/context`     | Context        | Agent context inspector                                                                                                    |
| `/workstreams` | Workstreams    | Active work streams; `?altitude=` selects the slice (see Widget parameterization)                                          |
| `/tasks`       | Tasks          | List + graph subpages (`/tasks/graph`, `/tasks/:id`)                                                                       |
| `/asks`        | Asks           | Interactive ask management                                                                                                 |
| `/activity`    | Activity       | Event stream                                                                                                               |
| `/embeddings`  | Embeddings     | Provider health + index coverage                                                                                           |
| `/memories`    | Memories       | Memory subsystem — browse, search, stats, detail, health (mt#2150)                                                         |
| `/settings`    | Settings       | Cockpit configuration + credentials                                                                                        |

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

| Widget ID                                                                                      | Page                | Surface                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`, `attention`, `basic-health`, `context-inspector`, `credentials`, `embeddings-health` | `/`                 | Home System-Status card grid                                                                                                                          |
| `task-graph`, `task-list`, `workstreams`                                                       | Dedicated pages     | Page route only (excluded from the home grid); `workstreams` self-fetches with an `altitude` param (mt#2385)                                          |
| `memories-health`                                                                              | `/memories`         | Page-level health indicator (sourced from `EmbeddingsHealthTracker.getInstance().getSummary()` — same data as the home-page `embeddings-health` card) |
| `memories-stats`                                                                               | `/memories`         | Stats panel: totals by type, recent count, top accessed, superseded count                                                                             |
| `memories-list`                                                                                | `/memories`         | Browseable record table with type + scope filters                                                                                                     |
| `memories-search`                                                                              | `/memories`         | Search bar consuming `memory_search`; surfaces `degraded` flag when embeddings provider is down                                                       |
| `memories-detail`                                                                              | `/memories` (modal) | Detail view: full content, associations, metadata, superseded-by chain, similar records                                                               |

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

**Health endpoint override:** set `MINSKY_REVIEWER_HEALTH_URL` to point at a different host. Default: `https://minsky-reviewer-webhook-production.up.railway.app/health` (the Railway public domain for the `minsky-reviewer-webhook` service).

**Polling interval:** 30 s (backend) / 30 s (frontend TanStack Query `refetchInterval`).

## Ask advancement sweep (mt#2265)

The cockpit daemon runs the **ask advancement sweep**: one pass at boot, then
every 60s (`startAskAdvancementSweeper` in `src/cockpit/server.ts`, domain
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

## Daemon lifecycle and tray

- `cockpit-tray/` — Tauri v2 menu bar app
- [ADR-014](adr-014-cockpit-daemon-lifecycle-ownership.md) — daemon lifecycle ownership (tray-app supervisor; mt#2241)
- Bundle auto-rebuild (mt#2297): the tray keeps the served production bundle fresh — a startup pre-flight rebuild (when `src/cockpit/web/**` is newer than `dist/`) plus a runtime filesystem watcher that rebuilds on source changes (excluding `dist`/`node_modules`/`.git`). A "Last build" line in the tray menu shows when the bundle last refreshed; build failures surface there (serving the prior bundle on a runtime failure, refusing to spawn when there is no bundle at all). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Bundle auto-rebuild_.
- Backend auto-restart (mt#2299): the **server-side** complement to the bundle rebuild. The widget registry and route table load at process start, so when backend source (`src/cockpit/server.ts`, `widget-registry.ts`, `widgets/**`, `config.ts`, `types.ts`) changes, the running daemon is stale (new widgets return `Widget not found`) until it restarts. The daemon spawns from source (`bun run src/cli.ts`), so a plain process restart picks up backend changes with no build step. The tray (a) restarts an **adopted** daemon at startup if backend source is newer than the daemon's start time (the originating 2026-06-04 8-day-stale case), and (b) watches `src/cockpit/**` (excluding `web/**`, which the mt#2297 rebuild path owns) and restarts the daemon on a debounced backend change. A "Daemon uptime" line shows how long the daemon has run + the source mtime it was started against, so operators can confirm currency at a glance; a crash-loop on restart (e.g. a syntax error) surfaces the stderr tail in the status line instead of a silent "stopped". Operators never need to manually `kill <pid>` or know that backend changes require a restart (caveat: restart/stop of an _adopted_ daemon depends on `lsof`/`ps` availability + a killable holder; otherwise the tray surfaces the conflict message rather than killing a foreign listener). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Backend auto-restart_.
- mt#2141 — follow-up: evaluate repointing Claude Code at shared HTTP MCP

## Cross-references

- `src/cockpit/CLAUDE.md` — design vocabulary, engineering standards, IA posture (auto-loaded)
- Memory `Cockpit stack and design/engineering bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — durable cross-cutting reference
- mt#1143 — Cockpit v0 umbrella
- mt#2149 — embeddings-health overview card (DONE 2026-05-27)
- mt#2150 — Memories page (this doc's `/memories` entry)
- mt#2147 — `EmbeddingsHealthTracker` backend (DONE 2026-05-27)
