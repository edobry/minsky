# Standing pointings

Reference for the `tasks pointings` command family (mt#5129 — Phase 1b of the
backlog-prioritization RFC, Notion `3ae937f0`, accepted 2026-09-13).

"Standing pointing" is a working label, not a decided name; the concept sets domain
precedent and the name is the principal's. These commands introduce identifiers only.

## What a pointing is

The backlog has no puller: work gets selected only when the principal points a
conversation at an area, and momentum ends with the conversation. A pointing makes that
act of pointing durable. It is a **saved query** over fields tasks already carry — tags,
parent subtrees, explicit ids, combined as a union — plus the **autonomy class** agents may
pull at and a **WIP limit** (both consumed by Phase 2's pull-time admission control, stored
now so a declaration is complete).

Only the DEFINITION is persisted (`pointings` table, migration 0118). Nothing computed is
stored: no candidate set, no WIP count, no queue. The candidate set is evaluated at read time,
which is what keeps a pointing a selection object rather than the first-class workstream entity
the RFC defers to Phase 3 (cold dispatch).

Pointings are the principal's to declare. `declare` and `archive` are principal-facing writes.

## Commands

All four are shared-registry commands: `minsky tasks pointings <verb>` on the CLI,
`tasks_pointings_<verb>` over MCP. They scope to the resolved project the way `tasks similar`
does, falling open to all projects when the identity does not resolve.

### `declare`

```
minsky tasks pointings declare <name> [--tags a,b] [--parentIds mt#1,mt#2] [--taskIds mt#7] \
  [--autonomyClass pull-only|principal-gated|contained] [--wipLimit N]
```

- `name` — unique among LIVE pointings in the project. An archived pointing's name may be reused.
- `tags` — a task matches if it carries ANY listed tag.
- `parentIds` — a task matches if it sits ANYWHERE under a listed parent (the whole subtree).
- `taskIds` — explicit ids to include.
- `autonomyClass` — default `pull-only`. `wipLimit` — default 1, a positive integer.

At least one of `tags`, `parentIds`, `taskIds` must be non-empty. Refusals are outcomes, not
throws (ADR-004): `{ success: false, reason }` with `reason` one of `empty-query`,
`invalid-class`, `invalid-wip-limit`, `name-taken`. `name-taken` covers the concurrent case too —
the partial unique index is the arbiter, and a unique violation on insert maps to the same outcome.

### `list`

```
minsky tasks pointings list [--includeArchived]
```

Live pointings by default; `--includeArchived` shows archived ones too.

### `archive`

```
minsky tasks pointings archive <id>
```

Sets `archivedAt`; the row is never deleted, so a pointing's history stays citable. Refuses
`not-found` and `already-archived` as outcomes.

### `candidates`

```
minsky tasks pointings candidates <id> [--cap N]
```

Evaluates the pointing's query over the OPEN backlog — status not DONE / CLOSED / BLOCKED, kind
not `work-package` (ADR-046: a package is claimed deliberately, never auto-served) — and returns
at most `cap` items (default and maximum 10; a larger `cap` is clamped). The response:

```
{
  "pointing": { "id", "name", "autonomyClass", "wipLimit" },
  "ordering": "arbitrary",
  "matched": 25,
  "truncated": true,
  "cap": 10,
  "items": [
    { "id": "mt#…", "title", "status",
      "readiness": 1.0, "unblockCount": 2, "incidentLineage": false, "daysSinceTouched": 12,
      "autonomyClass": "pull-only" }
  ]
}
```

**The order carries no meaning.** It is a shuffle, re-seeded per call, and labelled
`ordering: "arbitrary"` so no consumer can lean on it. Nothing here ranks: the RFC measured the
readiness tie at roughly 500 tasks wide, and sorting on nulls produces an arbitrary order wearing
the costume of a judgment. No field named score, rank, or priority exists anywhere in the response.

The four flags, per item:

- `readiness` — the same formula `tasks available` uses: terminal dependencies over all
  dependencies, `1.0` with none.
- `unblockCount` — how many OPEN tasks depend on this one.
- `incidentLineage` — the `incident` tag, or a spec `Origin:` line naming an incident. Never a
  free-text match: a third of the backlog mentions the word.
- `daysSinceTouched` — from `updated_at`.

Plus `autonomyClass` (mt#5130): the task's computed class — `principal-gated`, `pull-only`,
`contained`, or `unknown` (`docs/autonomy-class.md`). An annotation, not a filter: membership in a
pointing never overrides the class, so a `principal-gated` candidate is the principal's to pick and
is never auto-selected. The consumer-side deny lands on Phase 2's pull.

An **empty set is returned as-is**. It is the RFC's signal that a pointing is done and the moment
to ask for a new one — not an error.

## For other mechanisms

`evaluatePointingQuery(db, query, projectScope)` (`packages/domain/src/tasks/pointings-store.ts`)
returns the ids a query matches without going through the command. The remainder sweep below uses
the same matcher to ask "does any live pointing match this task?" before parking one.

## The remainder (mt#5131)

Everything outside every live pointing has a stated disposition rather than a count (RFC §Roadmap
Phase 1): an open task untouched 90+ days that no live pointing matches is **parked** — `CLOSED`,
tagged `auto-expired`, spec annotated — and **resurrected** (`CLOSED → TODO`, tag removed, spec
annotated) when a pointing's query matches it. The predicate, the exclusions and the reopen path:
`docs/task-kinds.md §Parked tasks`.

Two entry points, one mechanism (`packages/domain/src/tasks/remainder-expiry.ts` — pure — and
`remainder-expiry-store.ts`):

- **`minsky tasks expire-remainder`** — dry-run by default: prints `park`, `wouldPark`, `resurrect`
  and the pointing ids checked, writes nothing. `--execute` applies. `--cap N` bounds parks.
- **The `remainder-expiry` loop on `minsky-ops`** (`src/commands/ops/remainder-expiry-tick.ts`,
  registered in `start-command.ts`): daily; `REMAINDER_EXPIRY_ENABLED` (default off),
  `REMAINDER_EXPIRY_EXECUTE` (default off = shadow: computes and logs the plan, writes nothing),
  `REMAINDER_EXPIRY_INTERVAL_MS`, `REMAINDER_EXPIRY_TICK_CAP` (default 50 parks per tick). Enabling
  it and running the first execute are operator steps (mt#5138) — the first `--execute` is a bulk
  mutation over shared state and runs under a wrapper task after its dry-run is recorded.

**`declare` resurrects in the same call.** A pointing declared after a park brings its parked tasks
back immediately: the response carries `resurrected: string[]` (and `resurrectionError` if that
best-effort step failed — the pointing is still declared, and the next sweep tick resurrects the
same rows).

**With zero live pointings nothing is parked.** "Outside every live pointing" is vacuous then; the
dry-run reports `parkingSuspended: "no live pointings"` with the `wouldPark` set, so the count is
visible before the first pointing exists.

Every park and every resurrection emits a `task.status_changed` event with `via` naming the caller
(`cli`, `ops-loop`, or `pointings.declare`), so the event ledger records each decision. An executed
sweep (the CLI with `--execute`, or the loop with `REMAINDER_EXPIRY_EXECUTE`) additionally emits one
`remainder.expiry.run` event carrying the parked and resurrected id lists and counts, the pointing ids
it checked against, and `parkingSuspended` when the park half did not run — one ledger row per run,
so a bulk park is attributable to the run that made it. A dry-run emits nothing.

## What this does not do (yet)

No pull, no claim, no lease, no WIP admission, no spec-freshness check at queue entry — those are
Phase 2 (continuation-pull). No cockpit widget — that follows the mt#5123 design pass. No
computed autonomy class for a TASK — that is mt#5130; this stores only the class a POINTING declares.
