# Extend embeddings infra: server-side filtering and index-optimized queries

## Context

# Extend embeddings infra: server-side filtering and index-optimized queries

## Summary
Add first-class support for pre-filtered similarity search in the embeddings/vector layer so domain filters (e.g., task `status`, `backend`) are applied BEFORE ANN scoring. Design for performance, correctness, and extensibility across domains and backends.

## Problem
Current filtering happens after ANN search and enhancement. This can:
- Return irrelevant results that are later discarded
- Reduce recall-quality for the constrained set
- Waste resources and degrade UX for large corpora

## Goals
- Server-side pre-filtering (e.g., `status`, `backend`) at the vector query level
- Keep ANN index usability and planner friendliness
- Generic, extensible API usable by tasks, rules, and future domains
- Preserve memory backend behavior with graceful fallbacks

## Non-goals
- Re-ranking algorithm changes (handled by callers)
- Semantic changes to threshold semantics

## Design

### Data model (denormalization-first)
- Denormalize simple categorical filters into embeddings table (e.g., `status`, `backend`):
  - `tasks_embeddings(task_id text primary key, embedding vector(d), dimension int, status task_status, backend task_backend, updated_at timestamptz, last_indexed_at timestamptz)`
- Rationale:
  - Enables filtered ANN queries without JOINs (which often defeat ANN index usage)
  - Allows partial indexes/partitions for selective fast paths

### Indexing strategy
- Prefer partial indexes per filter value or partitions:
  - Partial index (HNSW):
    - `CREATE INDEX idx_tasks_emb_hnsw_todo ON tasks_embeddings USING hnsw (embedding) WHERE status = 'TODO';`
  - Or partition by `status` with per-partition ANN index
- Benefits:
  - WHERE predicate matches index/partition pruning, ANN index remains usable

### Query shape (Postgres)
- Base:
  - `SELECT task_id, (embedding <-> $1::vector) AS score FROM tasks_embeddings WHERE status = $status ORDER BY embedding <-> $1::vector LIMIT $k;`
- Multi-filter (status + backend):
  - `... WHERE status = $status AND backend = $backend ...`
- Threshold still applied server-side if possible (optional second-stage filter if needed)

### API changes (VectorStorage)
- Extend `VectorStorage.search()` signature to accept optional `filters`:
  - `search(queryVector: number[], opts?: { limit?: number; threshold?: number; filters?: Record<string, any> })`
- Backends:
  - Postgres: translate supported filters to WHERE clauses on denormalized columns
  - Memory: pre-filter candidate IDs/metadata if available; otherwise document post-filter fallback

### Ingestion/indexing
- Ensure importer populates `tasks_embeddings.status` and `tasks_embeddings.backend` and updates on change
- Add migration to add columns + default/backfill from `tasks` table on first run (one-time sync), then rely on runtime updates

### Config/compatibility
- Feature flag: `vectorStorage.filters.enabled` (default true for Postgres backend)
- Backward compatible defaults: if no filters are provided, behavior unchanged

## Testing
- Unit tests for Postgres storage:
  - `WHERE status = 'TODO'` uses index scan on partial index/partition (EXPLAIN validate)
  - Combined filters (status + backend)
  - Threshold correctness
- End-to-end tasks search:
  - Verify pre-filter reduces candidate set and results are consistent with `tasks list` semantics
- Memory backend:
  - Pre-filter candidates when metadata present; otherwise verify documented post-filter fallback

## Rollout
- Phase 1: Schema migration + denormalized columns + population from importer and runtime updates
- Phase 2: VectorStorage API + Postgres WHERE support
- Phase 3: Update `tasks.search` to pass filters to storage (keep CLI flags unchanged)
- Phase 4: Add partial indexes/partitions per high-traffic filters; document ops guidance

## Risks & mitigations
- JOINs break index usage → avoid joins; denormalize into embeddings table
- Index explosion with too many filter combos → limit to high-value columns; use two-stage candidate pruning for complex cases
- Drift between `tasks` and `tasks_embeddings` status → ensure runtime updates on status change + periodic reconciler

## Relationships
- Depends on: `md#253` embeddings infra, tasks metadata in DB
- Enables and complements: `md#447` (generic similarity with pluggable backends & fallback)

## Acceptance Criteria
- VectorStorage supports searchable filters (Postgres) with WHERE-based pre-filtering
- `tasks.search --status` applies pre-filter at storage layer
- Index strategy documented and validated with EXPLAIN
- Tests passing across Postgres + memory backends


## Requirements

## Solution

## Notes
