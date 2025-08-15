# Implement Task Backend Capabilities System and Enhanced Metadata Support

## Status: IN-PROGRESS

> Correction: Previous version incorrectly marked full spec/metadata separation and hybrid backends as completed. Hybrid backends and a dedicated MetadataDatabase abstraction are not implemented. This task is reopened to complete the separation using the new Postgres-based embeddings infrastructure introduced in PR #89.

## Current Reality (post PR #89)

- ✅ Embeddings and similarity search implemented with PostgreSQL + pgvector, reusing the session DB connection (`vectorStorage.postgres.useSessionDb = true`)
- ✅ `task_embeddings` table exists with columns: `id`, `task_id`, `dimension`, `embedding (vector)`, `metadata JSONB`, timestamps
- ❌ No `TaskSpecStorage` / `HybridTaskBackend` in code
- ❌ No `MetadataDatabase` implementation for tasks (only sessions have Postgres/SQLite storage backends)
- ❌ No GitHub/Markdown + SQLite hybrid task backends

See: [PR #89](https://github.com/edobry/minsky/pull/89) for embeddings work and schema details.

## Objective (updated)

Implement true spec/metadata separation by extending the existing `task_embeddings` table into a general task metadata store while preserving existing embeddings.

- Preserve embeddings and similarity features
- Add general task metadata (dependencies, subtasks, provenance) in JSONB
- Normalize legacy task IDs to qualified format without data loss
- Reuse the existing Postgres session database; enable future SQLite/PGlite mapping

## Plan

### 1) Schema evolution (non-breaking)

- Extend `task_embeddings` with:
  - `qualified_task_id TEXT` (nullable initially), unique index
  - `task_metadata JSONB DEFAULT '{}'` (GIN index)
  - `content_hash TEXT`, `last_indexed_at TIMESTAMPTZ` (for staleness tracking)
- Migration steps (idempotent):
  - Add columns if not exist
  - Backfill `qualified_task_id` from `task_id` using rules: `^[0-9]+$` → `md#<id>`; leave pre-qualified as-is
  - Add unique constraint on `qualified_task_id` (deferred until backfill complete)
  - Keep table name as `task_embeddings` to avoid disruption, but treat it as metadata+embeddings

### 2) Services

- Introduce `TaskMetadataService` with:
  - `getTaskMetadata(qualifiedId)` / `setTaskMetadata(qualifiedId, data)`
  - Relationship helpers: `getDependencies`, `setDependencies`, `getSubtasks`
  - Query helpers: `queryByMetadata` (JSONB predicates)
- Wire to use the same Postgres connection as session DB when configured

### 3) CLI and migration

- Add `tasks migrate-embeddings` command:
  - Dry-run by default; `--execute` to apply
  - Reports legacy vs qualified IDs, conflicts, updates performed
- Add `tasks metadata` commands (get/set/update/query) with JSON input/output

### 4) Backward/forward compatibility

- No changes required to similarity commands
- `tasks.index-embeddings` populates `content_hash`/`last_indexed_at`
- Future: optional rename to `task_metadata` table once codepaths fully adopt new fields

## Metadata schema (JSONB)

```ts
interface TaskMetadata {
  embedding?: { model: string; dimension: number; contentHash?: string; lastIndexed?: string };
  structure?: { parentTask?: string; subtasks?: string[]; dependencies?: { prerequisite?: string[]; optional?: string[]; related?: string[] } };
  provenance?: { originalRequirements?: string; aiEnhanced?: boolean; creationContext?: string; lastModified?: string };
  backend?: { sourceBackend?: string; externalId?: string; lastSync?: string; syncMetadata?: Record<string, any> };
  custom?: Record<string, any>;
}
```

## Acceptance Criteria (updated)

- [ ] Non-breaking migration extends `task_embeddings` with metadata fields
- [ ] Legacy `task_id` values normalized into `qualified_task_id` with dry-run + execute flow
- [ ] `TaskMetadataService` implemented with CRUD, relationships, and query
- [ ] CLI: `tasks migrate-embeddings`, `tasks metadata get/set/update/query`
- [ ] Documentation updated and examples provided

## Notes

- This delivers the core of Task #315 using the proven Postgres path first
- SQLite/PGlite parity and hybrid backends can follow as separate tasks once Postgres path is stable
