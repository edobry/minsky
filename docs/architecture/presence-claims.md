# Presence claims — "who is working on this task right now"

Task-grain agent presence (mt#2562). Records a lightweight, session-independent
claim whenever an agent actively touches a task through MCP, and exposes it so
the next agent (or the principal) can answer **"who is on task mt#X, and
where?"** with a single Minsky read instead of OS forensics (`lsof` / `ps` /
terminal-app introspection).

> **Doc-home note.** The reviewer's doc-impact heuristic on PR #1755 named
> `docs/mcp-migration-guide.md` as the affected doc, but that file is a narrow
> historical record of the Task #322 → #329 MCP-schema migration — a poor home
> for a new-subsystem reference. Per the Documentation Taxonomy a new deployed
> subsystem is an **architecture reference** (`docs/architecture/<feature>.md`),
> which is this file. It closes the same documentation gap (the tool + feature
> are now described in `docs/`).

## What it is (and is not)

- **Is:** an informational, best-effort presence signal. A claim says "actor A
  touched task mt#X at time T from context C". It is **advisory** — it informs
  the "probe before claiming a shared resource" check; it does **not** lock a
  task or block a second agent.
- **Is not:** a mutual-exclusion lock, a session-liveness signal
  (`deriveSessionLiveness`, mt#951), or a last-touched-by identity field
  (`agentId`, mt#1078). Presence is its own orthogonal dimension and is
  recordable even when **no Minsky session exists**.

## Storage

Postgres-only (ADR-018). Table `presence_claims` (migration slot `0050`):

| Column               | Notes                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `id`                 | uuid PK                                                            |
| `subject_kind`       | grain discriminator — `task` in v1; `session` / `subagent` later   |
| `subject_id`         | canonical task id (see Normalization)                              |
| `actor_id`           | the `_meta["io.minsky/agent_id"]` value (mt#1078)                  |
| `cc_conversation_id` | nullable — the "where" (Claude Code conversation)                  |
| `tty`, `host`        | nullable — the "where" (terminal / machine)                        |
| `session_id`         | nullable — set only when the claim coincides with a Minsky session |
| `project_id`         | nullable FK → `projects.id`; **stamped on write** (see below)      |
| `claimed_at`         | when the claim was first made (preserved across refreshes)         |
| `last_refreshed_at`  | bumped on every touch; drives staleness                            |

`UNIQUE(subject_kind, subject_id, actor_id)` makes repeat touches a refresh, not
a duplicate. `INDEX(subject_kind, subject_id)` serves the read query.

**Cross-grain by design (mt#2562 owns the schema, decision [C]).** The
`subject_kind` discriminator lets the session grain (mt#2284) and subagent grain
(mt#2292) adopt this exact table with zero DDL changes — they write rows with a
different `subject_kind`. Grain-specific extras (e.g. mt#2284's `entrypoint` /
terminal-context bag) are deferred nullable additions.

## Write path (session-independent)

`MinskyMcpServer.writeTaskClaim` (`src/mcp/server.ts`) fires **fire-and-forget**
at the `CallToolRequestSchema` seam — alongside the `agentId` write — on **every
tool call that carries `args.task` or `args.taskId`**, regardless of whether a
Minsky workspace session exists. That session-independence is the whole point:
it catches an agent working a task directly in the main repo (no session) — the
case `lsof`-based session-attachment detection structurally cannot see.

- `actor_id` is resolved via the existing `resolveCallerAgentId`.
- `project_id` is resolved (`resolveProjectIdentity` → `resolveProjectScope`)
  and **stamped on write** — the explicit lesson from mt#2563 (asks shipped
  read-scoping without write-stamping, so rows were invisible to the
  default-scoped list; presence does not repeat that mistake).
- Failures are swallowed and logged at debug level — presence is best-effort and
  never surfaces to the MCP caller.

Wiring lives in `src/commands/mcp/start-command.ts`: when the persistence
provider resolves, the server's `PresenceClaimRepository` is set; absent a DB the
write path is a no-op (graceful degradation).

## Normalization (subject_id canonicalization)

The write and read paths MUST key on the same `subject_id` or claims fragment.
`normalizeTaskSubjectId` (`packages/domain/src/presence/normalize.ts`) is the
single canonicalizer both sides call. It collapses every surface form of the same
task to one key, defaulting a bare number to the `mt` backend (global `mt#N`
numbering) while keeping backend prefixes distinct:

```
"mt#2562" / "MT#2562" / "mt-2562" / "mt2562" / "#2562" / "2562"  → "mt2562"
"md#160"  / "md-160"                                             → "md160"
```

It delegates lowercasing + separator-stripping to the existing tested
`normalizeTaskId` (`packages/domain/src/session/task-correspondence.ts`).

## Read surface — `tasks.claims.list`

MCP tool `tasks_claims_list` — "who is actively working on this task right now."

| Parameter          | Type    | Default | Notes                                               |
| ------------------ | ------- | ------- | --------------------------------------------------- |
| `taskId`           | string  | —       | required; any surface form (`mt#2562` / `2562` / …) |
| `staleThresholdMs` | number  | 15 min  | age past which a claim is flagged stale             |
| `includeStale`     | boolean | `false` | include stale claims in the result                  |

Response shape:

```jsonc
{
  "taskId": "mt2562", // the normalized subject id
  "claims": [
    // ordered most-recently-refreshed first
    {
      "actorId": "...",
      "ccConversationId": "...", // nullable where-context
      "tty": "...",
      "host": "...",
      "sessionId": "...",
      "claimedAt": "ISO",
      "lastRefreshedAt": "ISO",
      "stale": false,
    },
  ],
  "total": 1,
  "fresh": 1,
  "stale": 0,
}
```

Best-effort: when no SQL persistence provider / DB connection is available it
returns `{ claims: [] }` rather than throwing.

## Staleness & reaping

A claim is **stale** when `last_refreshed_at` is older than
`PRESENCE_CLAIM_TTL_MS` (15 min) — a working agent touches the task well inside
that window. `listClaims` annotates each claim with a `stale` flag; the read tool
filters stale by default. `reapStale(olderThanMs)` deletes claims older than
`PRESENCE_CLAIM_REAP_MS` (24 h) so a hard-killed agent does not leave a phantom
claim forever. (Actor-process pid-liveness is local-only and grain-specific —
deferred; TTL is the v1 staleness signal.)

## Verification

`scripts/smoke-presence-claims.ts` — env-gated on `DATABASE_URL`; exercises the
upsert → list → reap round-trip against real Postgres (skips gracefully without a
DB).

## Cross-references

- mt#2562 — this subsystem (task grain; owns the canonical schema).
- mt#2284 — session-workspace presence (`session ps`); adopts this schema.
- mt#2292 — subagent→task identity; adopts this schema.
- mt#1990 — substrate RFC (the shared-blackboard vision this implements a slice of).
- mt#1078 — `agentId` `_meta` channel (the actor identity reused here).
- mt#2563 — the asks project_id write-stamping lesson this honors.
- CLAUDE.md §"Probe before claiming a shared resource" — the discipline this
  capability mechanizes into a single read.
