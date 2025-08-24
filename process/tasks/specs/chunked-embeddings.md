# Implement chunked embeddings with overlap across similarity infra

## Context

Embedding large task specs can exceed provider token limits and degrade retrieval quality when stored as a single vector. We already have per-model caps and truncation, but optimal recall requires chunked embeddings with overlap and per-chunk retrieval. This should integrate cleanly with the general embedding/similarity infrastructure and future reranking pipeline described in `md#446-extract-generic-similarity-search-service-with-pluggable-backends-and-fallback-chain.md`.

## Summary

Introduce chunked embeddings with sliding-window overlap for tasks (Phase 1) and rules (Phase 2), updating indexing and search flows to operate at chunk granularity while keeping task-level UX. Maintain compatibility with current storage during migration and expose configuration for chunk size/overlap.

## Scope

- Phase 1 (Tasks):
  - Add chunked indexing pipeline (tokenizer-based, sliding window with overlap)
  - New storage for per-chunk vectors
  - Update similarity search to retrieve by chunk, aggregate to tasks
  - CLI flags: `--chunk-size`, `--chunk-overlap`, `--use-chunks` (default on after GA)
  - Staleness/skipping per chunk using `content_hash`
- Phase 2 (Rules):
  - Mirror the Tasks support for rules embeddings

## Relationships

- Builds on: `md#446-extract-generic-similarity-search-service-with-pluggable-backends-and-fallback-chain.md` (generic similarity service, reranking layer)
- Complements: existing truncation and per-model caps

## Acceptance Criteria

- Indexing creates multiple embeddings per task when content exceeds `chunk-size` tokens with `chunk-overlap` tokens overlap
- Storage persists per-chunk vectors and metadata; skipping respects per-chunk `content_hash` and model
- Search retrieves top-K chunks, aggregates to task-level results (best-chunk score + optional aggregation metric)
- CLI:
  - `tasks index-embeddings` supports `--chunk-size`, `--chunk-overlap`, `--use-chunks`
  - `tasks search` uses chunked retrieval when enabled and clearly indicates when chunking is active
- Tests cover chunking, skipping, aggregation, and CLI behavior
- Documentation updated; defaults are safe and configurable

## Design

### Chunking

- Use tokenizer-based chunking by tokens (preferred) with sliding window
- Defaults: `chunk-size = 1000` tokens, `chunk-overlap = 200` tokens
- Preserve section order; prefer starting chunks at logical boundaries when identifiable (e.g., headings), otherwise fall back to fixed windows

### Storage

- New table (example): `tasks_embedding_chunks`
  - `task_id` (TEXT, FK to tasks)
  - `chunk_id` (INT, 0..N-1 per task)
  - `vector` (pgvector)
  - `content_hash` (TEXT, NOT NULL)
  - `indexed_at` (TIMESTAMPTZ)
  - `metadata` (JSONB/TEXT) — include `{ model, dimension, startToken, endToken }`
  - PK: `(task_id, chunk_id)`; index on `vector` as appropriate
- Keep existing `tasks_embeddings` for single-vector path during migration; add config/flag to select chunks

### Indexing

- For each task, produce chunks using tokenizer; compute per-chunk `content_hash`
- Skip unchanged chunks; insert/update changed ones; delete orphaned chunk rows when content shrinks
- Honor per-model caps before chunking only for pathological cases; generally prefer chunking over hard truncation
- Retry/backoff via existing IntelligentRetryService

### Search

- Compute embedding for query; search against chunk vectors
- Aggregate: group results by `task_id` and select best chunk per task; preserve original chunk score; attach `chunk_id` and offsets
- Optional second-stage reranking (see `md#446`); wire via the generic similarity service interface

### CLI

- `tasks index-embeddings`:
  - Flags: `--chunk-size`, `--chunk-overlap`, `--use-chunks`, `--reindex`, `--concurrency`
  - Logging shows per-task actions and number of chunks indexed/skipped
- `tasks search`:
  - If chunks enabled, indicate aggregation source and provide best-chunk details in JSON output

### Migration Strategy

- Step 1: Create new table and code paths guarded by `--use-chunks`
- Step 2: Backfill chunks for existing tasks incrementally
- Step 3: Make chunks default, leave single-vector path for fallback

### Tests

- Unit: chunker (token boundaries, overlap), staleness by chunk, aggregation logic
- Integration: end-to-end indexing and search with chunks, CLI flags behavior
- No skipped tests; local provider path for CI

### Config

- New config keys under `embeddings.chunking`:
  - `enabled` (bool), `chunkSize`, `chunkOverlap`
- Per-model overrides allowed under `embeddings.models[model].chunking`

### Risks & Mitigations

- Storage growth: mitigate with reasonable defaults and pruning
- Query latency: offset by early aggregation and optional reranking top-K
- Consistency: ensure orphaned chunk rows are removed on re-index

## Done When

- Tasks: chunked indexing/search implemented, documented, tested, and enabled by config/flag
- Rules: parity implemented or tracked as a follow-up task
