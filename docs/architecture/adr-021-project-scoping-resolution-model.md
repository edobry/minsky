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

### Writes resolve from the entity, not the process (mt#2391, amending the above)

The model above governs **reads**. Writes take the opposite default, and this section records that
as a decision rather than a deviation: a new row's `project_id` comes from **the entity the row is
about** — its parent task, the workspace it names — falling back to the filing context only when no
entity answer exists.

The asymmetry is not an inconsistency. A read asks _"what am I looking at from here?"_, and the
process context is the correct answer to that. A write asks _"what does this row belong to?"_, which
only the row's own subject can answer; the filing context records which server the agent happened to
be connected to, which is a fact about the connection and never about the entity. Stamping a write
from the process context produced one entity with two project identities depending on which page
rendered it (mt#4772's originating defect).

- **Precedence**, where more than one answer exists: an explicit `workspace`/`repo` the caller named
  → the parent entity's project → the filing context. Explicit beats inherited because an argument
  the caller passed is an instruction while a parent's project is an inference; a caller wanting the
  parent's project omits the argument (mt#4808).
- **Every resolver fails open** to the next level and finally to the context. A create must not
  fail, nor silently NULL its project, because a lookup did.
- **Seam choice follows reachability, not layering.** Applied at `session.start` (mt#4758),
  `tasks.create` (mt#4808), `asks.create` (mt#4772), and `DrizzleAskRepository.create` (mt#4848).
  The fourth is deliberately a repository-layer seam: four of the seven Ask writers live in
  `packages/domain/**` and cannot reach an adapter-layer resolver taking a DI container, while every
  writer passes through the repository. Picking the seam by the widest writer set also covers writers
  not yet written — which is what the first three seams, chosen per call site, did not.

The strict-enforcement counterpart (NOT NULL on `project_id`, erroring on unidentified) remains
deferred to Phase-1.3b as recorded under `## Consequences`.

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

## User-facing behavior (mt#2416)

### Default project scoping on reads

After mt#2416, the CLI and per-session stdio MCP daemon scope their list and
search operations to the **current project by default**:

| Operation                                    | Default scope   | Opt-out flag                           |
| -------------------------------------------- | --------------- | -------------------------------------- |
| `minsky tasks list`                          | Current project | `--all-projects`                       |
| `minsky session list`                        | Current project | `--all-projects`                       |
| `minsky memory list` / `memory.list` MCP     | Current project | `--all-projects` / `allProjects: true` |
| `minsky memory search` / `memory.search` MCP | Current project | `--all-projects` / `allProjects: true` |
| `minsky asks list` / `asks.list*`            | Current project | `allProjects: true`                    |

"Current project" is resolved from the process working directory via
`resolveProjectIdentity` (git-remote / config-slug / env lookup) and then
`resolveProjectScope` (slug → `projects` table uuid). When the project is
unidentified (no git remote, no config, or the hosted server's `/app` cwd),
the result falls back to ALL / unscoped — preserving today's behavior for
the hosted server and the cockpit cross-project dashboard.

### `--all-projects` / `allProjects` opt-out

Pass `--all-projects` (CLI) or `allProjects: true` (MCP) to any list or
search command to bypass project scoping and return rows from all projects.
This is useful for cross-project audit queries, the cockpit dashboard, and
migration tooling.

### Write stamping

New **session** and **memory** records are also stamped with the resolved
`project_id` at creation time (mt#2416 writers):

- `session.start` stamps `project_id` on the new session row via the DB
  connection supplied to the session writer (fallback: NULL when unidentified).
- `memory.create` defaults `project_id` to the resolved current scope when
  no explicit `projectId` is provided; an explicitly-provided value is always
  respected.
- `asks.create` stamps `project_id` from the **parent task's** project when the
  Ask has a `parentTaskId`, and from the filing context otherwise (mt#4772).
  The parent wins because an Ask is ABOUT its parent task, while the filing
  context only records which server the agent was connected to; the lookup
  reuses mt#4808's `resolveTaskProjectId` and fails open to the context at
  every step. Before this, a parented Ask stamped the filing context and so
  listed under the wrong project on `/asks`, while its own activity event —
  keyed on `relatedTaskId` — rendered under the right one: one entity, two
  project identities depending on the page.

  (This bullet previously read _"Ask write-stamping is deferred to Phase-1.3b —
  the Ask domain type does not yet carry a `projectId` field."_ That was stale
  from mt#2563, which added the field and the stamp; `toInsert` has carried
  `projectId` since. The residual defect was never a missing field, only a
  mis-resolved value — a distinction worth preserving here, because the stale
  wording pointed at the wrong fix.)

- `tasks.create` no longer stamps from the filing context alone (mt#4808).
  It resolves per call, in precedence order: an explicit `workspace`/`repo`
  the caller named → the `parent` task's project → the filing context
  (unchanged fallback). Explicit beats inherited because an argument the
  caller passed is an instruction while a parent's project is an inference;
  a caller wanting the parent's project omits the argument. Every lookup
  fails open to the next level — a create must not fail, or silently NULL its
  project, because a lookup did. Resolved in
  `packages/domain/src/project/new-task-project.ts`; the per-call value
  reaches the row through `CreateTaskOptions.projectId`, which overrides the
  backend's construction-time `currentProjectId` (the MCP path injects a boot
  singleton, so nothing per-call could reach the insert without that seam).

- `DrizzleAskRepository.create` resolves `project_id` for **every** Ask writer,
  not only the ones going through `asks.create` (mt#4848). mt#4772's fix held on
  one write path of seven; the other six construct `CreateAskInput` directly and
  never set `projectId`, so they emitted NULL rows at a rate that kept the NULL
  population growing rather than static. The repository is the one seam all seven
  pass through, and it holds `this.db`, which the resolution's task lookup needs;
  `toInsert` is a pure mapper and cannot do a read. Verified live: over the 120
  Asks created in the 40 hours after deploy, zero carried a NULL `project_id`
  against a project-carrying parent, and the newest NULL-`project_id` Ask in the
  table predates the fleet's post-merge restart.

**Deviation from `## Decision` — RESOLVED 2026-09-02 (mt#2391).** This note
previously read _"recorded not resolved,"_ naming two entity-resolving write
paths with `asks_create` still open. All four have since shipped, so the
deviation has been folded into `## Decision` as
`### Writes resolve from the entity, not the process` rather than left as an
exception to it. The bullets above remain the per-call-site detail; the rule
they instantiate now lives with the decision.

## Cross-references

- Related ADRs: ADR-002 (persistence provider architecture), ADR-018 (domain persistence pattern)
- Strategic frame: RFC "Minsky beyond Minsky" (Notion `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`)
- Tasks: mt#2391 (Phase 1 umbrella), mt#2414 (resolver), mt#2415 (schema+backfill),
  mt#2416 (W1 — scope param + CLI/stdio supplier; lands this ADR), mt#2417 (embeddings audit),
  mt#2418 (cockpit supplier), mt#2505 (auto-migrate decouple; gates Phase-1.3b hardening),
  mt#4758 / mt#4808 / mt#4772 / mt#4848 (the four entity-resolving write seams),
  mt#4839 (backfill of the rows written before them)
- Memory: `5c0a4f78` (auto-migrate prod hazard / Phase-1.3b rationale), `6e5e2631` (per-session
  daemon → shared-Postgres topology), `ae514f10` (the RFC memory)
