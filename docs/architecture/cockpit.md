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

## Daemon lifecycle and tray

- `cockpit-tray/` — Tauri v2 menu bar app
- [ADR-014](adr-014-cockpit-daemon-lifecycle-ownership.md) — daemon lifecycle ownership (tray-app supervisor; mt#2241)
- mt#2141 — follow-up: evaluate repointing Claude Code at shared HTTP MCP

## Cross-references

- `src/cockpit/CLAUDE.md` — design vocabulary, engineering standards, IA posture (auto-loaded)
- Memory `Cockpit stack and design/engineering bundle` (id `0cc1304c-0de3-4e5e-8e7a-b446bc70a995`) — durable cross-cutting reference
- mt#1143 — Cockpit v0 umbrella
- mt#2149 — embeddings-health overview card (DONE 2026-05-27)
- mt#2150 — Memories page (this doc's `/memories` entry)
- mt#2147 — `EmbeddingsHealthTracker` backend (DONE 2026-05-27)
