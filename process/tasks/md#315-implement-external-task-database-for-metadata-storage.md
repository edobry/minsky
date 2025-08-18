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

- Normalize and use existing `task_id` column (currently empty) instead of introducing a new field:
  - Backfill `task_id` with the normalized/qualified task ID (e.g., `md#<id>` for markdown tasks)
  - Add a unique constraint on `task_id` after backfill completes successfully
- Keep embedding tracking fields:
  - `content_hash TEXT`, `last_indexed_at TIMESTAMPTZ`
- Do NOT add a generic JSONB metadata column. We will add specific, first-class columns for metadata (e.g., `priority`, `category`, `tags`, relationships) in dedicated follow-up tasks as they are specified.
- Keep table name as `task_embeddings` for now to avoid disruption; in future we may rename after full adoption.

Migration steps (idempotent):

- Ensure `task_id` column exists (it does) and is nullable initially
- Compute normalized `task_id` from existing primary key `id` using backend-aware rules:
  - Numeric `^[0-9]+$` → `md#<id>` (markdown backend)
  - Already-qualified values remain unchanged
- Add unique index/constraint on `task_id` only after backfill validation passes

### 2) Services

- No generic metadata service at this time. We are not introducing arbitrary free-form metadata handling.
- Future metadata features (dependencies, tags, categories, priorities, etc.) will each add explicit columns and narrowly-scoped service/CLI operations in their own tasks/specs.

### 3) CLI and migration

- Add `tasks migrate-embeddings` command focused solely on ID normalization into `task_id`:
  - Dry-run by default; `--execute` to apply
  - Reports legacy vs normalized IDs, conflicts, updates performed
- No generic `tasks metadata get/set/update/query` commands.

### 4) Backward/forward compatibility

- No changes required to similarity commands
- `tasks.index-embeddings` continues to maintain `content_hash`/`last_indexed_at`
- Future, metadata-specific tasks will extend schema and surface narrowly-scoped commands as needed

## Metadata schema (JSONB)

```ts
interface TaskMetadata {
  embedding?: { model: string; dimension: number; contentHash?: string; lastIndexed?: string };
  structure?: {
    parentTask?: string;
    subtasks?: string[];
    dependencies?: { prerequisite?: string[]; optional?: string[]; related?: string[] };
  };
  provenance?: {
    originalRequirements?: string;
    aiEnhanced?: boolean;
    creationContext?: string;
    lastModified?: string;
  };
  backend?: {
    sourceBackend?: string;
    externalId?: string;
    lastSync?: string;
    syncMetadata?: Record<string, any>;
  };
  custom?: Record<string, any>;
}
```

## Acceptance Criteria (updated)

- [ ] Non-breaking migration populates `task_id` with normalized task IDs and adds a unique constraint post-backfill
- [ ] No generic JSONB metadata column added; future metadata is modeled with explicit columns in separate tasks
- [ ] CLI: `tasks migrate-embeddings` implements dry-run/execute flow for ID normalization only
- [ ] Documentation updated to reflect `task_id` normalization approach and forward plan for specific metadata fields

## Notes

- This delivers the core of Task #315 using the proven Postgres path first
- SQLite/PGlite parity and hybrid backends can follow as separate tasks once Postgres path is stable
