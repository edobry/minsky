# ADR-021: Project-scoping resolution model — explicit scope parameter supplied per consumer

## Status

Proposed

## Context

Phase 1 of "Minsky beyond Minsky" (mt#2391; RFC Notion `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`)
introduces project identity so one Minsky Postgres can hold multiple projects without
interleaving. Reads of `tasks` / `sessions` / `asks` / `memories` must filter by a resolved
"current project."

The datastore is single (one Postgres), but the **client topology is many**: the CLI, a
per-session stdio MCP daemon spawned per Claude Code session, the hosted HTTP MCP server, and
the local cockpit menu-bar daemon — all pointed at the one shared Postgres. These consumers
differ in how "current project" is even knowable: a CLI/stdio process is bound to one repo cwd
(resolvable from git-remote/config); the cockpit daemon is a cross-project dashboard bound to no
single repo (mt#2418 gives it a _filter_); the hosted server has no repo cwd and would need the
project from the request.

A 2026-06-16 DI/request-flow investigation established the constraints: domain services are
**boot-singletons** (fixed `workspacePath: process.cwd()`); there is **no per-request DI scoping,
no tsyringe child-container-per-request, and no AsyncLocalStorage** anywhere in the codebase; the
MCP `tool.handler(args)` receives only the raw JSON args; the cockpit daemon uses module-level
lazy singletons (no DI container) with Express `req.query` at each route; the hosted HTTP server
shares one container across all sessions and requests.

Alternatives considered and rejected:

- **Per-request DI scoping / child-container-per-request / AsyncLocalStorage** — none exist today;
  adopting one would be net-new infrastructure for no v1 benefit, and the domain singletons +
  args-only handler signature make it a large change.
- **A global process-level "current project" default** consulted by the query layer — silently
  pins the cockpit cross-project dashboard to one project, and a hidden ambient default is unsafe.
- **CLI-only per-process resolution** — leaves no path for the cockpit or hosted consumers.

## Decision

We will make project scope an **explicit parameter on the domain read methods** (`listTasks`,
`listSessions`, memory list/search, ask list), accepting a `project_id` (uuid) or an `allProjects`
sentinel. Each entry point supplies the value from its own context; the scope flows as an ordinary
method parameter from the request boundary through the call stack, independent of the
`workspacePath`/DI-singleton lifecycle.

- **CLI and stdio MCP** resolve the current project per-process via `resolveProjectIdentity`
  (mt#2414: cwd → git-remote / config-slug / env → slug → `projects.id` lookup), default reads to
  it, and expose an explicit `--all-projects` / `allProjects` opt-out.
- **Cockpit daemon** supplies `req.query.project` per request, defaulting to ALL (cross-project
  dashboard); slug→id resolution happens at the route (mt#2418).
- **Hosted HTTP MCP** in v1 resolves to unidentified→ALL (preserving today's single-project
  behavior). The future multi-project supplier injects `projectId` per request via the same
  `_meta` channel that already carries `agentId` (`injectAgentIdMeta`) — an additive third
  supplier, deferred until hosted multi-project demand exists.

**Default rule:** when no scope is supplied, resolve the current project; if **unidentified**
(no repo/remote/config — e.g. the hosted server's `/app` cwd), fall back to **ALL / unscoped**,
preserving current behavior.

## Consequences

Easier:

- Adding a new consumer (or the deferred hosted multi-project supplier) is **additive** — wire one
  more supplier of the same parameter; no refactor of the read layer or DI.
- Scope is **local and explicit** at each call site; there is no hidden ambient current-project to
  misread.
- **Incrementally safe**: unidentified→ALL means existing consumers (the hosted server, any
  unscoped path) keep today's behavior — no flag-day.

Harder / committed:

- Every read site must thread the parameter; a missed site silently leaves an unscoped query —
  mitigated by a grep acceptance test (mt#2416) asserting no default-path read is unscoped except
  named ALL views.
- The unidentified→ALL fallback is a deliberate _soft_ default: a misconfigured CLI (no
  remote/config) can see cross-project rows. Strict no-leak enforcement (NOT NULL on `project_id`
  - erroring on unidentified) is deferred to the Phase-1.3b hardening (gated on mt#2505).
- The scope parameter is a new contract on the domain read methods; the MCP tool wrappers, cockpit
  routes, and CLI adapters must adopt it.
- Per-request scoping for the hosted server is **not** solved here; it is deliberately deferred
  with a named hook (`_meta` injection), committing the future implementation to the `agentId`
  precedent rather than request-scoped DI.

## Cross-references

- Related ADRs: ADR-002 (persistence provider architecture), ADR-018 (domain persistence pattern)
- Strategic frame: RFC "Minsky beyond Minsky" (Notion `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`)
- Tasks: mt#2391 (Phase 1 umbrella), mt#2414 (resolver), mt#2415 (schema+backfill),
  mt#2416 (W1 — scope param + CLI/stdio supplier; lands this ADR), mt#2417 (embeddings audit),
  mt#2418 (cockpit supplier), mt#2505 (auto-migrate decouple; gates Phase-1.3b hardening)
- Memory: `5c0a4f78` (auto-migrate prod hazard / Phase-1.3b rationale), `6e5e2631` (per-session
  daemon → shared-Postgres topology), `ae514f10` (the RFC memory)
