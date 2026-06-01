---
name: data-engineering-lens
description: >-
  Apply the core Designing Data-Intensive Applications (Kleppmann) decision frames at
  data-design time, as a checklist — not a book summary. Use when designing a schema,
  a new persistence path, a cache/index/materialized view, a sync mechanism, an
  event/queue, or a schema migration: it asks the system-of-record-vs-derived-data,
  no-dual-writes, denormalization-tradeoff, rebuildability, idempotency, and
  schema-evolution questions before the design locks in. The filtered-vector-search
  skill is a specialization of these frames.
user-invocable: true
---

# Data-Engineering Lens (DDIA)

Six decision frames from _Designing Data-Intensive Applications_ that recur in Minsky's
data decisions. Each is "when designing X, ask Y, to avoid failure mode Z." Run the
relevant ones at **design time** — the cost of asking is a minute; the cost of skipping
is a silent drift bug or a painful migration later. This is a checklist of lenses, not a
summary of the book.

Specialized by `/filtered-vector-search` (the vector-search instance of frames 1–4).
Composes with `/declare-framework` (strategic recommendations) and `decision-defaults.mdc`
(`§Datastores`, `§Reliability`).

## When to invoke

- Designing or changing a **schema** (new table, new column, field rename/retype).
- Adding a **cache, index, materialized view, search index, or embeddings table**.
- Choosing a **sync mechanism** between two stores (app-write, trigger, CDC, batch).
- Introducing an **event/queue/stream** or a consumer of one.
- Writing a **migration** (especially one that changes stored shapes or drops data).
- Any "should this live in store A or B, and how do they stay consistent?" question.

## The frames

### 1. System-of-record vs. derived data

**Ask:** Which store is the _authoritative_ source of this fact, and which stores merely
_derive_ it (and could be rebuilt from the source)?

Name the system of record explicitly. Caches, indexes, search/vector indexes,
materialized views, denormalized columns, and read models are **derived data** —
subordinate to a source, and kept in sync by a _systematic dataflow_, never by ad-hoc
parallel writes. If you can't name the single authoritative source, the design has a
consistency hole.

**Failure mode:** two stores each treated as authoritative → they disagree and there's no
rule for who wins.

**Minsky example:** `tasks_embeddings` is derived from the `tasks` table (the system of
record for status). Treating the embeddings row's denormalized `status` as authoritative
caused mt#2220 (ADR-013).

### 2. No dual writes — derive, don't dual-write

**Ask:** Is application code writing the same fact to two places? If so, stop.

A dual write (app writes store A _and_ store B for the same fact) drifts the moment any
writer forgets, errors, or races — DDIA Ch. 11's canonical broken pattern. Pick one source
of truth and **derive** the other: a DB trigger, change-data-capture, or a stream the
derived store subscribes to. Or eliminate the duplication entirely and read the source at
query time.

**Failure mode:** silent drift — the two copies diverge and nothing detects it.

**Minsky example:** the `tasks_embeddings.status` column was written (intended to be) by
the indexer alongside `tasks.status` — a dual write. The indexer forgot; 1,739 rows went
NULL; `tasks_search` silently broke (mt#2220, memory `70b595dc`). Fix: read live
`tasks.status` at query time (no duplication).

### 3. Denormalization is a read-time/write-time tradeoff (the mutability test)

**Ask:** How often does this field change, and are reads dominant enough to pay write-time
sync cost?

Denormalizing moves work from read-time to write-time. Worth it when **reads ≫ writes AND
the field is stable**. Denormalize immutable/slow fields freely (created_at, type, source,
owner). Be reluctant with **mutable lifecycle fields** (status, state, assignee): the
denormalized copy needs a sync mechanism, and the sync is where bugs live. At small scale,
prefer normalized + compute/join/filter at read time.

**Failure mode:** denormalizing a hot-changing field, then carrying a perpetual sync burden
(or skipping it and drifting).

**Minsky example:** per-org task corpora are thousands of rows — performance is not the
constraint, so denormalizing a mutable `status` for "server-side filtering" bought nothing
and cost a sync bug. See memory `5392795e` (the "denormalize" best-practice is a default
with preconditions; check them).

### 4. Derived data should be rebuildable

**Ask:** Can I blow this away and regenerate it from the source? If not, why not?

Prefer designs where caches/indexes/views can be dropped and rebuilt deterministically from
the system of record. Rebuildability is what makes derived data safe to evolve, re-shard,
or fix. A derived attribute with a _broken_ derivation (computed once, never refreshed) is
worse than no attribute — it looks live but lies.

**Failure mode:** a derived store that can't be rebuilt becomes a second source of truth by
accident; a stale-but-undetectable derived field.

**Minsky example:** task embeddings ARE rebuildable (reindex from task content). The
`status` column was derived-but-never-refreshed — the broken-derivation case.

### 5. Idempotency & dedup (at-least-once → exactly-once)

**Ask:** If this operation runs twice (retry, redelivery, replay), is the result the same?
What's the dedup key?

Networks and queues deliver at-least-once; "exactly-once" is achieved by making consumers
**idempotent** (dedup on a stable key, upsert instead of insert, `IF NOT EXISTS`,
content-hash gating). Design the dedup key before the queue, not after the duplicate.

**Failure mode:** double-applied side effects (double-charge, duplicate row, re-sent
notification) under retry.

**Minsky example:** `indexTask` gates on a content hash and upserts (`ON CONFLICT DO
UPDATE`) — re-indexing the same task is a no-op. Migration `DROP COLUMN IF EXISTS` is
idempotent by construction.

### 6. Schema & encoding evolution (backward/forward compatibility)

**Ask:** Will old code read new data, and new code read old data, during the rollout window?

Stored data outlives the code that wrote it; deploys are not atomic across a fleet. Prefer
additive changes (new optional columns/fields). For renames/retypes/drops, stage them
(add-new → backfill → switch readers → drop-old) so readers and writers overlap safely.
Enumerate the consumers before changing a contract.

**Failure mode:** a deploy where new code expects a column old rows don't have, or a rename
that strands in-flight readers — CI green, prod crash.

**Minsky example:** the `/plan-task` gate (h) contract-propagation enumeration exists for
exactly this; `tasks.content_hash` was dropped (migration 0011) but a consumer query still
referenced it, crashing `embeddings-repair` until mt#2220 fixed it.

## Scope (v1 lens set)

These six are the frames that recur in Minsky's current decisions (persistence, embeddings,
events, migrations, MCP schemas). Deliberately **out of v1**, add when a real decision needs
them: consistency models / linearizability, partitioning & rebalancing, distributed
consensus, and stream-processing topology. Propose an addition (with the Minsky decision
that motivates it) rather than importing the whole book.

## How to use

1. Identify which frames the decision touches (most schema/persistence decisions touch 1–4).
2. For each, answer its **Ask** in one or two sentences in your design notes / spec / ADR.
3. If an answer reveals a dual write, a hot-field denormalization, a non-rebuildable derived
   store, a missing dedup key, or an unstaged contract change — fix the design before
   building.

## Cross-references

- Kleppmann, _Designing Data-Intensive Applications_ — Ch. 3 (storage/derived data),
  Ch. 4 (encoding/evolution), Ch. 11 (stream processing / dual-writes / CDC).
- `/filtered-vector-search` (mt#2221) — the vector-search specialization of frames 1–4.
- `/declare-framework` (mt#1789) — name the framework for strategic recommendations.
- `decision-defaults.mdc §Datastores` (Postgres-via-Supabase), `§Reliability`
  (sweeper-not-queue) — Minsky-grounded datastore defaults these frames operate within.
- Memory `70b595dc` — derived data / unmanaged dual write (frames 1–2, 4).
- Memory `5392795e` — defaults have domains of validity (frame 3's precondition check).
- Memory `61bc8282` — shared-infra latent bugs (the column-the-writer-forgets class).
- mt#2220 / ADR-013 — the worked example threaded through frames 1–4.
