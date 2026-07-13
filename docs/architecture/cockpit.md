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

Two id-spaces (mt#2398/mt#2420/mt#1919 — do not conflate; vocabulary per ADR-022 stage 1,
mt#2686): `/agents` and `/agents/:id` are keyed by the **Minsky workspace sessionId**
(`SessionRecord`); `/conversations` and `/conversation/:id` are keyed by the **harness
agentSessionId** (ingested transcript). The workspace detail page bridges the two — when the
workspace directory resolves to an ingested transcript's cwd, it links to the conversation at
`/conversation/:agentSessionId` (served by `GET /api/agents/:id`). (`/agents` and `/agents/:id`
keep their existing names — the Agents list/detail pair is a separate naming decision, out of
scope for the ADR-022 rename.)

## Routes

| Path                       | Page              | Purpose                                                                                                                                                                                                   |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | Home              | Attention digest (full top row) + system-status card grid; the rail is the navigation surface (nav tiles removed, mt#2398)                                                                                |
| `/agents`                  | Agents            | Workspaces in flight — rows open the workspace detail at `/agents/:id`                                                                                                                                    |
| `/agents/:id`              | Workspace detail  | Workspace entity tab — liveness, linked task, recent commits, PR state, conversation link (mt#1919; `WorkspaceDetailPage`/`WorkspaceDetail`, renamed from `SessionDetailPage`/`SessionDetail` by mt#2686) |
| `/conversation/:id`        | Conversation      | Conversation entity tab — readable conversation view of the transcript (mt#2374; supersedes the interim `/conversation` verification host; path renamed from `/session/:id` by mt#2686)                   |
| `/context`                 | Context           | Agent context inspector                                                                                                                                                                                   |
| `/workstreams`             | Workstreams       | Active work streams; `?altitude=` selects the slice (see Widget parameterization)                                                                                                                         |
| `/tasks`                   | Tasks             | List + graph subpages (`/tasks/graph`, `/tasks/:id`)                                                                                                                                                      |
| `/asks`                    | Asks              | Interactive ask management                                                                                                                                                                                |
| `/activity`                | Activity          | Event stream                                                                                                                                                                                              |
| `/embeddings`              | Embeddings        | Provider health + index coverage                                                                                                                                                                          |
| `/memories`                | Memories          | Memory subsystem — browse, search, stats, detail, health (mt#2150)                                                                                                                                        |
| `/settings`                | Settings          | Cockpit configuration + credentials                                                                                                                                                                       |
| `/plant`                   | Plant Board       | Whole-system VSM plant board (mt#2375+); S2 valve interlock count is derived (mt#2602)                                                                                                                    |
| `/plant/interlock-history` | Interlock history | Interlock provenance timeline: install date, commit link, linked `retrospective.fired` event (mt#2602; renamed from `/plant/weld-history`, mt#2626)                                                       |

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

| Widget ID                                                                                      | Page                                 | Surface                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`, `attention`, `basic-health`, `context-inspector`, `credentials`, `embeddings-health` | `/`                                  | Home System-Status card grid                                                                                                                                                           |
| `task-graph`, `task-list`, `workstreams`                                                       | Dedicated pages                      | Page route only (excluded from the home grid); `workstreams` self-fetches with an `altitude` param (mt#2385)                                                                           |
| `memories-health`                                                                              | `/memories`                          | Page-level health indicator (sourced from `EmbeddingsHealthTracker.getInstance().getSummary()` — same data as the home-page `embeddings-health` card)                                  |
| `memories-stats`                                                                               | `/memories`                          | Stats panel: totals by type, recent count, top accessed, superseded count                                                                                                              |
| `memories-list`                                                                                | `/memories`                          | Browseable record table with type + scope filters                                                                                                                                      |
| `memories-search`                                                                              | `/memories`                          | Search bar consuming `memory_search`; surfaces `degraded` flag when embeddings provider is down                                                                                        |
| `memories-detail`                                                                              | `/memories` (modal)                  | Detail view: full content, associations, metadata, superseded-by chain, similar records                                                                                                |
| `slow-topology`                                                                                | `/plant`, `/plant/interlock-history` | Derived guard-hook registry + interlock history (install date, commit link, retrospective correlation); reads only the sweeper's in-process cache, never derives per-request (mt#2602) |

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
  disproportionate at this tier. The Rung 2A WS channel (mt#2750) WILL require the token once it
  ships.
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
the platform proxy and is out of scope here. Because both entrypoints share the same
`createCockpitServer()` factory, the Railway entrypoint passes `isPublicDeployment: true`
(`CockpitServerOptions`), which skips the Host-header allowlist and the bearer-token/cookie
mutation-auth for that deployment — its incoming `Host` header is a Railway-assigned public
hostname that could never satisfy the loopback-only allowlist, and introducing a mutation
bearer-token requirement to an already-shipped multi-consumer production surface is out of
scope for this task. The CSP header and the no-CORS policy are additive/response-only, so they
still apply to the Railway deployment too. The Rung 3 cloud→local relay channel (mt#2238) owns
its own, distinct auth surface for that separate concern.

## Daemon lifecycle and tray

- `cockpit-tray/` — Tauri v2 menu bar app
- [ADR-014](adr-014-cockpit-daemon-lifecycle-ownership.md) — daemon lifecycle ownership (tray-app supervisor; mt#2241)
- Bundle auto-rebuild (mt#2297): the tray keeps the served production bundle fresh — a startup pre-flight rebuild (when `src/cockpit/web/**` is newer than `dist/`) plus a runtime filesystem watcher that rebuilds on source changes (excluding `dist`/`node_modules`/`.git`). A "Last build" line in the tray menu shows when the bundle last refreshed; build failures surface there (serving the prior bundle on a runtime failure, refusing to spawn when there is no bundle at all). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Bundle auto-rebuild_.
- Backend auto-restart (mt#2299): the **server-side** complement to the bundle rebuild. The widget registry and route table load at process start, so when backend source (`src/cockpit/server.ts`, `widget-registry.ts`, `widgets/**`, `config.ts`, `types.ts`) changes, the running daemon is stale (new widgets return `Widget not found`) until it restarts. The daemon spawns from source (`bun run src/cli.ts`), so a plain process restart picks up backend changes with no build step. The tray (a) restarts an **adopted** daemon at startup if backend source is newer than the daemon's start time (the originating 2026-06-04 8-day-stale case), and (b) watches `src/cockpit/**` (excluding `web/**`, which the mt#2297 rebuild path owns) and restarts the daemon on a debounced backend change. A "Daemon uptime" line shows how long the daemon has run + the source mtime it was started against, so operators can confirm currency at a glance; a crash-loop on restart (e.g. a syntax error) surfaces the stderr tail in the status line instead of a silent "stopped". Operators never need to manually `kill <pid>` or know that backend changes require a restart (caveat: restart/stop of an _adopted_ daemon depends on `lsof`/`ps` availability + a killable holder; otherwise the tray surfaces the conflict message rather than killing a foreign listener). All of it no-ops on a no-source install. See `cockpit-tray/README.md` § _Backend auto-restart_.
- mt#2141 — follow-up: evaluate repointing Claude Code at shared HTTP MCP

## Cross-references

- `src/cockpit/CLAUDE.md` — design vocabulary, engineering standards, IA posture (auto-loaded)
- mt#2538 — daemon security hardening (loopback bind default, bearer-token auth, CSP, no-CORS
  policy — see "Bind, auth, and CSP posture" above); `src/cockpit/auth.ts`, `src/cockpit/csp.ts`
- mt#2750 — Rung 2A driven-session WS channel; will REQUIRE the bearer token this task introduces
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
  local-only cockpit — no external consumers).
