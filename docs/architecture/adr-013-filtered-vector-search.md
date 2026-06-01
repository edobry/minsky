# ADR-013: Filtered Vector Search — Domain-Layer Read-Time Post-Filter, Not Denormalized Index Columns

## Status

**ACCEPTED** — Documented 2026-06-01. Originating task: `mt#2220` (the `tasks_search`
filter bug). Tasks live in the Minsky DB, not the filesystem — query via
`mcp__minsky__tasks_get`. Related follow-ups: `mt#2221` (filtered-vector-search skill),
`mt#2222` (DDIA-grounded data-engineering lens skill). Cross-references memories
`70b595dc` (derived data / dual write), `61bc8282` (shared-infra latent bugs),
`5392795e` (defaults have domains of validity).

## Context

`mcp__minsky__tasks_search` combines two operations: **nearest-neighbor search** over
task embeddings, and a **metadata filter** that excludes `DONE`/`CLOSED` tasks (unless
`--all`). Combining "nearest neighbors" with "matching a filter" is _filtered vector
search_ — the central design problem in this space, with three standard strategies:
pre-filter, post-filter, and in-filter (single-stage).

### The bug that surfaced this (mt#2220)

`tasks_search` silently returned only tasks with id ≲ mt#465; every more-recent task was
invisible, while `tasks_similar` (no filter) worked across the full corpus. Root cause,
verified at three levels (code, SQL three-valued logic, live DB):

1. The search path built `filters = { statusExclude: ['DONE','CLOSED'] }`, which
   `PostgresVectorStorage.searchInternal` turned into `WHERE status NOT IN ('DONE','CLOSED')`
   against a **denormalized `status` column** on `tasks_embeddings`.
2. The indexer (`indexTask` → `storeInternal`) **never populated** that column — it was
   added by migrations 0014/0015 but no writer maintained it. 1,739 of 2,102 rows had
   `status = NULL`.
3. `NULL NOT IN ('DONE','CLOSED')` evaluates to `NULL` → treated as FALSE → the row is
   excluded. Only ~363 rows from a one-time manual backfill (all pre-mt#465) survived, so
   the result set was frozen at that era. `degraded: false` throughout — silent.

### The deeper framing (DDIA)

`tasks_embeddings` is **derived data** subordinate to a system of record (the `tasks`
table, which owns `status`). Copying a **mutable lifecycle field** into the derived index
and relying on application code to keep both in sync is a **dual write** (Kleppmann, DDIA
Ch. 11) — the canonical broken pattern; it drifts the moment any writer forgets. This is
the third instance of the same `getVectorStorageForDomain` wiring gap (memory `61bc8282`
covered `metadata`/`content_hash`).

### What the community default says, and why it doesn't apply here

The mainstream best practice for filtered vector search _is_ "denormalize the filter field
onto the vector row, index it, filter server-side" (optionally kept fresh by a trigger/CDC).
But that default has implicit preconditions — large scale, performance-bound queries, a
_stable_ filter field, single-app schema. This case violates all of them:

- **Scale:** per-org corpora are thousands, not millions; day-to-day search is within one
  org. Every strategy is sub-millisecond. Performance is not a constraint.
- **Mutability:** `status` is a lifecycle field that changes on every transition — the worst
  fit for denormalization, and exactly the field whose un-synced copy caused the bug.
- **Reusability/hermeticity:** the generic vector store backs rules/tools/transcripts/
  memory/principal-corpus. Baking task `status` semantics into it couples the shared core
  to one domain.

Additionally, `tasks_embeddings` carries an HNSW (approximate) index and the filter is
highly selective (~75% of tasks are `DONE`/`CLOSED`). That is precisely the configuration
where pgvector's documented post-filter recall problem bites — so even a _correctly
populated_ `WHERE` filter would need iterative scans / partial indexes / `ef_search` tuning
to be reliable.

## Decision

**Filter at read time, in the domain layer, against the live source of truth — do not
denormalize the mutable field into the shared index.**

Concretely, `TaskSimilarityService.searchByText` now:

1. Takes the same domain-filter intent (`status` / `statusExclude` / `backend`) but **does
   not** forward it to the generic vector store.
2. **Fast path:** when no domain filter is present (`similarToTask`, `searchSimilarTasks`),
   searches the full corpus directly — unchanged behavior.
3. **Filtered path:** loads live task metadata once (`searchTasks({})`), computes the
   observed pass-rate, and **over-fetches** a candidate window sized from that pass-rate
   (`ceil(limit / passRate) * 2`, floored at 50, capped at the corpus size). It drops
   candidates failing the live predicate, and **widens to the full corpus** if fewer than
   `limit` survive. This is the application-layer equivalent of pgvector 0.8's iterative
   scan.

The generic `PostgresVectorStorage` keeps its domain-agnostic `filters` capability (it is
not coupling — it filters by whatever column is named); it is simply no longer used for the
mutable task-status case. The denormalized `status`/`backend` columns on `tasks_embeddings`
become vestigial (drop tracked separately; see Consequences). No backfill is required,
because nothing reads the column anymore. The indexer is **not** changed to write status —
that would re-introduce the dual write.

## Consequences

**Positive**

- The bug class is removed, not patched: there is no denormalized copy to forget or sync,
  so it cannot drift. Single source of truth (`tasks.status`).
- No production data migration / backfill needed for correctness.
- The generic vector store stays domain-agnostic — supports the goal of a hermetic,
  reusable embeddings subsystem. Domain knowledge (what "excluded" means) lives in the
  domain service.
- Correct at any selectivity; the adaptive widen handles the 75%-excluded case and avoids
  the pgvector approximate-index post-filter recall trap.
- Establishes the reusable pattern: future embedding domains that need to filter on a
  mutable field do the same read-time post-filter (skill `mt#2221`).

**Negative / costs**

- Over-fetch + a full task-metadata load per filtered search. Cheap at per-org scale
  (thousands; one lightweight query, no spec content), but it is more work per query than a
  single indexed `WHERE`. This is the explicit scale trade — see escape hatch.
- The `status`/`backend` columns on `tasks_embeddings` remain until a follow-up drops them;
  they are inert (unread) but should be removed to retire the footgun.

**Escape hatch (if per-org scale ever grows ~100×)**

Migrate to in-DB filtering done _consistently_: denormalize the filter field with a
**Postgres trigger or CDC** propagating `tasks.status` → `tasks_embeddings.status` (a scalar
copy — never a re-embed), plus a **partial index** or pgvector `hnsw.iterative_scan` to keep
recall correct under high selectivity. The trigger is what makes denormalization safe (the
database enforces sync instead of application discipline). Until that scale arrives, it is
unjustified machinery.

## Alternatives considered

- **A — Denormalize + sync (finish migrations 0014/0015 + a trigger).** The community
  default. Rejected for now: it denormalizes a _mutable_ field into a _shared_ core for
  _performance we don't have_, needs trigger/CDC sync wiring plus pgvector recall mitigation
  at 75% selectivity, and requires a 1,739-row production backfill. It is the documented
  escape hatch at large scale.
- **B — Domain-layer read-time post-filter (chosen).** See Decision.
- **C — JOIN `tasks_embeddings` to live `tasks` at query time.** Single source of truth and
  server-side, but couples the generic store to the `tasks` table (breaking domain-agnosticism)
  and is the least-recommended option in the literature for performance. Rejected.

## References

- Memory `70b595dc` — derived data / unmanaged dual write (DDIA Ch. 11).
- Memory `5392795e` — defaults have domains of validity (why this isn't a reversal of the
  "denormalize" best practice).
- Memory `61bc8282` — shared-infra latent bugs (`getVectorStorageForDomain` column-wiring gaps).
- Kleppmann, _Designing Data-Intensive Applications_, Ch. 11 (derived data, dual writes).
- pgvector filtered-search recall problem and 0.8 iterative scans (per-task research, mt#2220).
