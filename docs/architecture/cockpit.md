# Cockpit (mt#1143)

The **cockpit** is the operator-facing surface for Minsky's own system state — a local web
server showing what the system is doing, who is working on what, and which decisions are
waiting on the operator. It is the first instantiation of a more general concept (**Locus**)
and the externalization, into infrastructure, of cognitive functions that otherwise live in
operator working memory.

This document describes what the cockpit is, where it sits in the VSM architecture, how the
widget framework lets it grow without rewriting the shell, and which Minsky subsystems feed
it. For implementation details see mt#1143 and its subtasks; for the philosophical motivation
see the two Notion essays linked at the end.

---

## Cockpit and Locus

**Locus** is the general theory: the operator-facing surface that holds and renders the
"orientation" half of an OODA loop for a one-person organization running many parallel agents.
It is not specific to Minsky. Any system where a principal coordinates parallel cognition needs
something Locus-shaped — a durable, glanceable place where in-flight state lives outside
biological working memory.

**Cockpit** is the first concrete instantiation of Locus inside Minsky. It is bounded to
Minsky's own state — sessions Minsky tracks, tasks in Minsky's task system, asks routed
through Minsky's attention-allocation subsystem. AI activity that doesn't bind to Minsky
(Claude Code sessions that never invoke an MCP tool; off-system agent runs) is out of scope
by construction.

The naming distinction matters: future work may produce other Locus instantiations
(cross-project view, multi-principal view, terminal-integrated view) that share Locus's
shape but differ in scope. Calling the v0 surface "cockpit" — and reserving "Locus" for the
theoretical frame — keeps that future space open.

---

## VSM placement

Stafford Beer's Viable System Model identifies five functional organs. The cockpit is the
operator-facing **externalization of Systems 2, 3, and 4** — the organs that, in a
one-person organization, normally live in biological working memory. See
[`docs/theory-of-operation.md`](../theory-of-operation.md) for the full five-organ mapping.

| VSM organ                             | What it does                                       | Cockpit surface                                                           |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| **System 1** (Operations)             | The work itself: sessions, tasks, code changes     | Underlying data; not "in" the cockpit, but rendered by it                 |
| **System 2** (Coordination)           | Anti-oscillatory signals between parallel workers  | Agents widget — who is working on what, liveness state                    |
| **System 3** (Operational feedback)   | Monitors operations, closes the loop               | Workstreams widget — task-tree status rollup; PR / merge state            |
| **System 4** (Strategic intelligence) | Scans environment for threats and opportunities    | TaskGraph widget — interactive DAG; dependency drill-down                 |
| **System 5** (Self / identity)        | Policy, identity, what the system won't compromise | Lives in `.minsky/config.yaml` + rules; the cockpit's frame, not a widget |

The cockpit does not implement these organs — Minsky's domain subsystems do. The cockpit
**renders** them as glanceable surfaces so the operator (System 5) can make informed
decisions without rebuilding context from scratch on every interaction.

### The algedonic channel

Beer reserves a separate channel — the **algedonic channel** — for signals that must reach
System 5 directly, bypassing the normal feedback hierarchy. Algedonic literally means
"pain-pleasure": these are the alerts that demand principal attention because no lower-level
resolver can handle them.

In the cockpit, the **Attention widget** (mt#1147) is the algedonic surface. It renders
unresolved asks routed to the operator via the attention-allocation subsystem (mt#1034,
ADR-008). Algedonic selection is enforced structurally: only asks whose `routingTarget ===
"operator"` ever appear; asks resolved at lower levels (by policy, by peer agents, by
reviewer subagents) never surface. The widget does not just display asks — it filters them
algedonically by construction. See [ADR-008](adr-008-attention-allocation-subsystem.md) for
the underlying subsystem.

### Operator-facing, not agent-facing

A subtle but load-bearing distinction: the cockpit is for the **principal operator**, not
for AI agents. Agents already have rich orientation infrastructure — context generation,
rules compilation, MCP-based introspection. The cockpit's user is the human running the
system. Its design decisions (web-primary rendering, dark-mode-first density, low-latency
polling) reflect operator ergonomics, not agent affordances.

---

## Widget architecture

The cockpit is a **shell + pluggable widgets**, not a monolithic UI. Adding a new dial to
the cockpit as Minsky gains observable capability is implementing a widget contract and
registering it in config — the shell does not change.

### Shell responsibilities

The shell (`src/cockpit/server.ts` + `src/cockpit/web/`) provides:

- **Widget registry** (`src/cockpit/widget-registry.ts`) — a map from widget ID to module
- **HTTP routes** — `/api/widgets` (list), `/api/widget/:id/data` (fetch), per-widget
  mutation endpoints when needed
- **Polling layer** — client-side TanStack Query orchestration with per-widget intervals
- **Layout + composition** — React tree mounting registered widget renderers
- **Graceful degradation rendering** — widgets that fail or have unmet dependencies render
  a `state: "degraded"` payload with a `reason` string; the shell surfaces this without
  crashing the rest of the UI
- **Config-driven enablement** — `~/.config/minsky/cockpit.json` toggles widgets;
  unregistered or disabled widgets are absent from the UI

### Widget contract

Each widget is a self-contained module declaring four things:

```ts
interface WidgetModule {
  id: string; // stable identifier, matches config + URL
  title: string; // display title
  updateMode: // polling interval OR manual
  { type: "polling"; intervalMs: number } | { type: "manual" };
  fetch(ctx: WidgetContext): // returns ok payload OR degraded reason
  Promise<WidgetData>;
}
```

The contract is intentionally narrow. Widgets are free in what they render but constrained
in how they declare themselves and how they fetch. The shell guarantees that a misbehaving
widget cannot bring down the cockpit — every `fetch()` is wrapped in an error boundary that
converts thrown exceptions into `degraded` payloads.

### Why "shell + widgets" and not a single UI

Three engineering consequences fall out of this shape:

1. **Independent shipping.** Widgets ship as separate PRs. The Agents widget (mt#1145)
   shipped before the TaskGraph widget (mt#1146), which shipped before the Attention
   widget (mt#1147). The shell stayed stable across all three.

2. **Graceful degradation.** When a widget's data source isn't ready (no DB connection;
   external API down; pre-shipped dependency like mt#1001 SSE), the widget degrades cleanly
   rather than blocking the whole surface. The Attention widget defaulted to enabled with
   "no active window" gracefully degraded state during the period when mt#1411 service
   windows weren't yet implemented.

3. **Future capability extension.** As Minsky gains new observable subsystems (cost / usage
   tracking; cross-project state; mesh signal flow), the natural move is a new widget —
   not a parallel UI, not a new tool. Widget toggle in config; no shell rewrite.

This is a recursive VSM application: the cockpit shell is itself a viable system whose
operational units are the widgets, coordinated by the shell's polling and routing.

### Frontend stack

The widget renderers use **shadcn/ui + Tailwind 3.x + TanStack Query** on a Vite-built
React SPA, served by an Express backend. The full stack is documented in
`src/cockpit/CLAUDE.md` (loads automatically when working on Cockpit code).

Stack-additions decision (mt#1773, DONE 2026-05-12): dark-mode-first, semantic-token-driven,
shadcn primitives for accessibility-first Radix-based components. The frontend stack is
deliberately distinct from the Minsky CLI's stack — the CLI uses a tsyringe DI container and
the Minsky shared command registry, while the cockpit is a standalone Express server with no
DI container.

---

## Subsystem map

The cockpit consumes data from several Minsky subsystems. Each widget is a thin renderer
over an existing domain capability — the cockpit does not own new state, it surfaces state
already managed by upstream subsystems.

| Widget      | Data source                                       | Underlying subsystem                                                                                                |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agents      | `SessionRecord` table                             | `src/domain/session/` — session liveness (mt#951 chain)                                                             |
| TaskGraph   | `tasks_deps_graph` query                          | `src/domain/tasks/` — task DAG + dependency edges (mt#239)                                                          |
| Workstreams | Task parent / child rollup                        | `src/domain/tasks/` — task graph reorganization (mt#1452)                                                           |
| Attention   | `pending_asks_for_window` SQL view + `asks` table | `src/domain/ask/` — Ask subsystem (mt#1034, ADR-008) + service-window primitives (mt#1411 stack: mt#1488/1489/1490) |
| BasicHealth | `process.uptime()` + widget count                 | The cockpit itself — health check + smoke test                                                                      |

### Subsystems that feed the cockpit but aren't owned by it

- **Mesh observability** — when mesh signals (mt#1001) ship, the cockpit will be a consumer
  of mesh notifications via SSE rather than the polling loop it uses today. The transport
  swap is a widget-internal change; the shell stays stable.
- **Attention allocation subsystem** (mt#1034, ADR-008) — defines the Ask entity, the
  routing model, the lifecycle states. The Attention widget is the v0 rendering surface for
  the operator-facing slice of this subsystem.
- **Agent identity** (mt#1078, ADR-006) — gives the Agents widget stable display names
  instead of UUIDs.
- **Knowledge base** — not currently surfaced in the cockpit. Could become a widget if a
  use case emerges (e.g., search box + recent ingestion status).

### Subsystems that are independent of the cockpit

- **Persistence layer** — the cockpit reads via existing repositories; it does not own
  schema or migration.
- **Rules compilation pipeline** — operates against AI agent contexts, not the cockpit.
- **Session lifecycle and PR workflow** — agents drive these via MCP; the cockpit observes.
- **CI / pre-commit hooks** — System 2 / System 3 infrastructure that runs without cockpit
  involvement.

The cockpit is a **rendering surface**, not a control plane. The operator can resolve asks
via the Attention widget (a write-back into the Ask lifecycle), but the cockpit does not
issue commands to agents, run merges, or modify task graphs. Mutations go through the same
domain layer the CLI and MCP use; the cockpit's mutation surface is intentionally narrow.

---

## v0 status (as of 2026-05-14)

All named v0 user-facing widgets are shipped:

| Subtask | Widget                                                                                                | Status                      |
| ------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| mt#1144 | Shell + widget framework                                                                              | DONE                        |
| mt#1145 | Agents                                                                                                | DONE                        |
| mt#1146 | TaskGraph                                                                                             | DONE                        |
| mt#1147 | Attention (real implementation)                                                                       | DONE (2026-05-14, PR #1125) |
| mt#1452 | Workstreams                                                                                           | DONE                        |
| mt#1518 | Frontend stack decision                                                                               | DONE                        |
| mt#1768 | Design + engineering bundle (10 children: shadcn migration, density treatments, agent + skill bundle) | CLOSED via children         |

Remaining work:

- **mt#1148** (push transport: polling → SSE) — blocked on mt#1001 (mesh signal push). The
  current polling loop is the v0 transport; SSE is the v1 upgrade once mesh signals ship.
- **mt#1143** (parent umbrella) — remains PLANNING as a multi-kind-workflow lifecycle
  artifact rather than implementation incompleteness; tracked by mt#1812.

The cockpit launches via `minsky cockpit`; it is local-only in v0. Multi-principal and
hosted deployment are out of scope by construction.

---

## Operator dev loop — lifecycle module + agent-driven inspection

mt#1904 introduced two coordinated subsystems for the cockpit dev loop:

### Workspace-keyed lifecycle (`src/cockpit/lifecycle.ts`)

The cockpit server writes its runtime state to a per-workspace file at
`~/.local/state/minsky/cockpit/<workspace-key>.json` on startup and removes it on
graceful shutdown. The workspace key is the session ID for session workspaces (resolved
from the working-directory path under `getSessionsDir()`) or the literal string `"main"`
for the main workspace.

State-file shape:

```ts
interface CockpitState {
  pid: number; // server process PID
  port: number; // listening port
  url: string; // http://localhost:<port>
  workspaceId: string; // session ID or "main" (matches the filename stem)
  workspacePath: string; // absolute path of the workspace the cockpit was started in
  startedAt: string; // ISO timestamp
  devChromiumPid?: number; // PID of Minsky's dev chromium, if launched for this cockpit
}
```

Multi-workspace concurrency is the reason for the per-workspace keying: under the
single-global PID file mt#1887 originally shipped, legitimate peer cockpits in different
operator session workspaces would have been misclassified as recoverable zombies. The
lifecycle module scopes recognition to **this workspace's prior cockpit** — peer cockpits
in other workspaces are always "unrecognized" and never auto-killed even with `--force`.

`src/cockpit/port-recovery.ts` (the mt#1887 module) was refactored to consume this module.

### Minsky-managed dev chromium (`src/cockpit/dev-chromium.ts`)

`minsky cockpit start` launches a shared dev chromium with
`--remote-debugging-port=9222 --user-data-dir=~/.local/share/minsky/dev-chromium` and a
small set of "first-run-suppressing" flags. The dev chromium spawns detached so it
survives `minsky cockpit` exit; subsequent invocations probe `/json/version` and reuse
the already-running instance. Its state lives at `~/.local/state/minsky/dev-chromium.json`.

The dedicated `--user-data-dir` keeps the dev chromium structurally separated from the
operator's main Chrome profile.

Detection is cross-platform — macOS, Linux, Windows — with `MINSKY_DEV_CHROMIUM_EXECUTABLE`
as the operator override for non-standard installs.

Opt-out: `minsky cockpit start --no-dev-chromium` skips the launch (for headless / CI
contexts where the inspection surface is unnecessary).

### chrome-devtools-mcp attachment

Configure `chrome-devtools-mcp` in your Claude Code MCP config with
`--browser-url=http://127.0.0.1:9222`:

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"],
    },
  },
}
```

All concurrent Claude Code sessions attach to the same dev chromium. Each session's agent
opens its workspace's cockpit URL as a NEW tab in the shared window, so the operator can
scan every active cockpit at a glance. The `cockpit-design` skill's Step 0 encodes the
URL-discovery + tab-selection procedure, AND auto-starts the cockpit server if it isn't
running for the current workspace (mt#1925) — operators don't have to remember to run
`minsky cockpit start` per session. The auto-start uses a cross-platform PID-liveness probe (Bun's `process.kill(pid, 0)` so
it works on macOS, Linux, and Windows under Bun), resolves the state-file path from
`MINSKY_STATE_DIR` / `XDG_STATE_HOME` with the same precedence as the lifecycle module
(no hardcoded `~/.local/state/...`), and has an opt-out via operator-direction phrase
("don't auto-start cockpit", "skip cockpit start", "I'll start it myself"). Windows
operators currently run `minsky cockpit start` manually — the auto-start shell snippet is
POSIX-scoped today.

### chrome://inspect gotcha (do not use)

Chrome 144+ added a `chrome://inspect/#remote-debugging` UI toggle that exposes a debug
port. **Do NOT use it for this setup.** chrome-devtools-mcp upstream issue #1194 is
closed as wontfix-by-design: `chrome://inspect/#remote-debugging` is intended for the
separate `--autoConnect` path (which requires per-connection auth dialogs and attaches to
the operator's main Chrome). For `--browser-url`, Chrome MUST be launched with the
explicit `--remote-debugging-port=` flag and a non-default `--user-data-dir` — which is
exactly what mt#1904's dev chromium does.

### Deferred hardening: page-id routing

mt#1912 tracks enabling chrome-devtools-mcp's `--experimentalPageIdRouting` flag if
cross-tab interference is ever observed in practice (two agents accidentally
manipulating each other's tabs in the shared chromium). v0 ignores this in exchange for
not depending on an experimental flag whose schema may shift; agents stick to the
discipline of "find tab by URL → select_page once → do work, done."

---

## Companion principles in the cockpit

The cockpit is shaped by the three companion principles named in
[`docs/theory-of-operation.md`](../theory-of-operation.md#companion-principles):

- **Attention as the scarce resource.** Every widget's information density and update
  cadence are calibrated against operator attention budget. The Attention widget's
  algedonic selection is the most direct expression: it does not show every Ask, only the
  ones structurally routed to the operator. Asks resolvable by policy or peer agents never
  reach this surface.
- **Humility as a design property.** The cockpit does not let agents act on the operator's
  behalf at System 5 scope. Mark-resolved on an Ask is a System 5 decision; the agent
  surfaces options, the operator decides. The cockpit is a rendering surface for operator
  decisions, not an autonomy delegation surface.
- **Noticing as a structural property.** The cockpit makes drift visible: stale sessions,
  unresolved asks, blocked task graphs. It cannot make the operator notice, but it
  removes the failure mode where state silently rots because no one was looking.

---

## Cross-references

### Tasks

- **mt#1143** — Cockpit v0 parent umbrella
- **mt#1144 / mt#1145 / mt#1146 / mt#1147 / mt#1452 / mt#1518 / mt#1768** — v0 subtasks
- **mt#1034** — Attention allocation subsystem (ADR + Ask entity)
- **mt#1411** — Service-window primitives consumed by the Attention widget
- **mt#1001** — Mesh signal push (gates SSE transport upgrade)
- **mt#1078** — Agent identity (feeds Agents widget display)
- **mt#1887** — Cockpit start: port-in-use recovery + `--open` flag
- **mt#1904** — Workspace-keyed lifecycle module + Minsky-managed dev chromium
- **mt#1912** — Deferred hardening: enable `--experimentalPageIdRouting` on observed cross-tab interference
- **mt#1925** — Skill-level cockpit auto-start (eliminates the rote `minsky cockpit start` step before agent UI inspection)
- **mt#1913** — Generic upstream-issue watcher (sibling of the chrome://inspect gotcha record)

### Docs

- [`docs/theory-of-operation.md`](../theory-of-operation.md) — VSM mapping, companion principles
- [`docs/architecture.md`](../architecture.md) — Minsky architecture overview
- [ADR-008](adr-008-attention-allocation-subsystem.md) — Attention allocation subsystem ADR
- [ADR-006](adr-006-agent-identity.md) — Agent identity scheme
- `src/cockpit/CLAUDE.md` — Cockpit-specific stack and conventions (auto-loaded when
  working on `src/cockpit/**`)

### Notion essays (philosophical depth)

- [The cockpit problem: from Locus theory to first instantiation](https://www.notion.so/33a937f03cb4819a8865e11164cbb1c8)
  — the founding essay introducing the cockpit / Locus distinction
- [The dogfooding inversion](https://www.notion.so/33b937f03cb48161ba1cce36a6751098) — why
  Minsky's operator surface is Minsky's first customer
