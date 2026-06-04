# Cockpit

Operator-facing mission-control web app for Minsky. Local-only v0 (`minsky cockpit`); web-primary, no TUI investment. Architecture is shell + widget framework — each widget is a self-contained module declaring its data dependencies, shipping independently, degrading gracefully when dependencies aren't ready.

Parent task: mt#1143. Engineering bundle: mt#1768.

## Stack

| Layer           | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Runtime         | Bun                                                                       |
| Server          | Express (`src/cockpit/server.ts`)                                         |
| Frontend        | React + Vite + Tailwind + shadcn/ui + TanStack Query (`src/cockpit/web/`) |
| Widget contract | Custom registry (`src/cockpit/widget-registry.ts` + `types.ts`)           |
| Config          | `~/.config/minsky/cockpit.json`                                           |

Deeper engineering conventions: `src/cockpit/CLAUDE.md` (auto-loaded for any file under `src/cockpit/**`).

## Routes

| Path           | Page        | Purpose                                                            |
| -------------- | ----------- | ------------------------------------------------------------------ |
| `/`            | Home        | System-status card grid + nav tiles to feature pages               |
| `/agents`      | Agents      | Sessions in flight                                                 |
| `/context`     | Context     | Agent context inspector                                            |
| `/workstreams` | Workstreams | Active work streams                                                |
| `/tasks`       | Tasks       | List + graph subpages (`/tasks/graph`, `/tasks/:id`)               |
| `/asks`        | Asks        | Interactive ask management                                         |
| `/activity`    | Activity    | Event stream                                                       |
| `/embeddings`  | Embeddings  | Provider health + index coverage                                   |
| `/memories`    | Memories    | Memory subsystem — browse, search, stats, detail, health (mt#2150) |
| `/settings`    | Settings    | Cockpit configuration + credentials                                |

## Widget IDs (operator configuration)

The home page renders only widgets enabled in `~/.config/minsky/cockpit.json`. Each widget declares an `id` matching `WidgetModule.id` in its backend module under `src/cockpit/widgets/`. Adding a new widget requires both shipping the code AND enabling it in this file:

```json
{
  "widgets": [
    { "id": "agents", "enabled": true },
    { "id": "attention", "enabled": true },
    { "id": "basic-health", "enabled": true },
    { "id": "context-inspector", "enabled": true },
    { "id": "credentials", "enabled": true },
    { "id": "embeddings-health", "enabled": true },
    { "id": "task-graph", "enabled": true },
    { "id": "task-list", "enabled": true },
    { "id": "workstreams", "enabled": true },

    { "id": "memories-health", "enabled": true },
    { "id": "memories-stats", "enabled": true },
    { "id": "memories-list", "enabled": true },
    { "id": "memories-search", "enabled": true },
    { "id": "memories-detail", "enabled": true }
  ]
}
```

The `memories-*` widget IDs (added in mt#2150) must be enabled for the `/memories` page to render its data. A widget that is registered in code but absent from the config returns `HTTP 404 "Widget not found"` from `/api/widget/<id>/data` — this is by design (the registry self-documents what's available; the config gates what's exposed). The `/memories` route itself is always reachable regardless of widget-enablement state; only the data panels degrade.

### Widget catalog by route

| Widget ID                                                                                      | Page                              | Surface                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`, `attention`, `basic-health`, `context-inspector`, `credentials`, `embeddings-health` | `/`                               | Home System-Status card grid                                                                                                                          |
| `task-graph`, `task-list`, `workstreams`                                                       | `/` (promoted to dedicated pages) | Card on home + page route                                                                                                                             |
| `memories-health`                                                                              | `/memories`                       | Page-level health indicator (sourced from `EmbeddingsHealthTracker.getInstance().getSummary()` — same data as the home-page `embeddings-health` card) |
| `memories-stats`                                                                               | `/memories`                       | Stats panel: totals by type, recent count, top accessed, superseded count                                                                             |
| `memories-list`                                                                                | `/memories`                       | Browseable record table with type + scope filters                                                                                                     |
| `memories-search`                                                                              | `/memories`                       | Search bar consuming `memory_search`; surfaces `degraded` flag when embeddings provider is down                                                       |
| `memories-detail`                                                                              | `/memories` (modal)               | Detail view: full content, associations, metadata, superseded-by chain, similar records                                                               |

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
- mt#2141 — follow-up: evaluate repointing Claude Code at shared HTTP MCP

## Cross-references

- `src/cockpit/CLAUDE.md` — design vocabulary, engineering standards, IA posture (auto-loaded)
- Memory `Cockpit stack and design/engineering bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — durable cross-cutting reference
- mt#1143 — Cockpit v0 umbrella
- mt#2149 — embeddings-health overview card (DONE 2026-05-27)
- mt#2150 — Memories page (this doc's `/memories` entry)
- mt#2147 — `EmbeddingsHealthTracker` backend (DONE 2026-05-27)
