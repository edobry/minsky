# Implement Minimal DB-Only Tasks Backend (db#) and Manual Export Command

Status: TODO
Priority: HIGH

## Summary

Introduce a minimal database-backed task backend (`backend = db`, task ID prefix `db#`) that treats the Postgres database as the source of truth for both metadata and spec content. Deprecate all reads of the monolithic `process/tasks.md`. Provide a manual export command to generate human-readable markdown artifacts, but do not perform exports automatically.

**CRITICAL FIX**: The current embedding generation is broken - it tries to embed from non-existent `description` and `metadata.originalRequirements` fields. Fix to embed from title + full spec content.

## Goals

- Create a new tasks backend type: `db` (ID prefix `db#`).
- Implement 3-table schema design: `tasks` (metadata), `task_specs` (content), `tasks_embeddings` (vectors).
- Treat DB as SoT (metadata + spec) for this backend.
- Stop reading `process/tasks.md` entirely in runtime command paths.
- **FIX EMBEDDINGS**: Update TaskSimilarityService to generate embeddings from title + full spec content.
- Reuse the existing migration/import flow to write tasks into the DB with `backend = db` instead of `markdown`.
- Implement a manual export command to generate read-only markdown artifacts for inspection/PRs (no inbound parsing).
- Add an optional strict mode to error on any usage/configuration of in-tree backends (markdown/json) while transitioning.

## Non-Goals (for this task)

- Field-level ownership policy, GI sync, or webhooks.
- Automatic/export-on-write behavior.
- Migration to new `db#` IDs across the codebase (links/aliases). For now, keep IDs as-is; revisit later as needed.

## Requirements

### Schema Design (3 Tables)

```sql
-- Core task metadata (lean, frequently accessed)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source_task_id TEXT,
  backend task_backend,
  status task_status, 
  title TEXT,
  content_hash TEXT,  -- for spec change detection
  last_indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spec content (large, accessed on-demand)
CREATE TABLE task_specs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,  -- full markdown spec content
  content_hash TEXT,      -- denormalized for fast change detection
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Embeddings (vector data for similarity search)
CREATE TABLE tasks_embeddings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  vector vector(1536),    -- OpenAI ada-002 dimension
  content_hash TEXT,      -- track when embeddings need regeneration
  indexed_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Schema/Config
- Ensure `task_backend` enum includes `db`.
- Allow tasks with `backend = db` to be created/read/updated.

### Backend/Adapter
- Register new `db` task backend implementation using 3-table design.
- All reads/writes for `db` backend go to/from DB only.
- Remove any fallback reads of `process/tasks.md`.

### Embedding Fix (CRITICAL)
- **BROKEN**: Current `TaskSimilarityService.extractTaskContent()` tries to embed from:
  - `task.title` ✅
  - `task.description` ❌ (often empty/undefined)
  - `task.metadata.originalRequirements` ❌ (doesn't exist)
- **FIX TO**: Embed from `task.title + task_specs.content` (full spec)
- Update `indexTask()` to read from `task_specs` table and embed title + full spec content.

### Migration/Import
- Update existing `tasks migrate`/import path so that it can write records as `backend = db` (option, or default when strict mode is enabled).
- Populate all 3 tables during import: `tasks`, `task_specs`, `tasks_embeddings`.
- Preserve idempotency and verification.

### Export (manual, not automatic)
- `minsky tasks export --format markdown --out docs/tasks/` (or similar) to write per-task files.
- Each file contains a prominent header: "GENERATED – DO NOT EDIT. Source of truth is the database."
- Stable formatting to minimize diffs; never read these files back.

### Guardrails (strict mode)
- Config flag (e.g., `tasks.strictDbMode: true`) that:
  - Errors if markdown/json backends are configured or resolved for runtime operations.
  - Logs a single deprecation warning if legacy files are present; errors in strict mode.

## CLI/MCP Surface (initial)

### MCP
- `tasks.spec.get(id)` - read from `task_specs` table
- `tasks.spec.set(id, content[, ifMatchContentHash])` with dry-run and optimistic concurrency.
- `tasks.meta.get/set` for DB-owned fields (optional in this task if already present; otherwise stub).

### CLI
- `minsky tasks export --format markdown --out <dir>` (manual export only).
- No automatic export on write.

## Implementation Steps

1. **Fix Embeddings FIRST**:
   - [ ] Update `TaskSimilarityService.extractTaskContent()` to read from `task_specs.content`
   - [ ] Ensure embeddings are generated from title + full spec content
   - [ ] Test embedding generation with actual spec content

2. **Schema Changes**:
   - [ ] Create migration to split current `tasks.spec` column into `task_specs` table
   - [ ] Update `task_backend` enum to include `db`
   - [ ] Migrate existing spec content to new table structure

3. **DB Backend Implementation**:
   - [ ] Create `DatabaseTaskBackend` class implementing 3-table design
   - [ ] Register `db` backend in task service factory
   - [ ] Implement CRUD operations across all 3 tables

4. **Import/Migration Updates**:
   - [ ] Update importer to populate all 3 tables for `db` backend
   - [ ] Add option to import as `backend = db`

5. **Manual Export Command**:
   - [ ] Implement `tasks export` command
   - [ ] Generate markdown files with do-not-edit headers

6. **Strict Mode**:
   - [ ] Add config flag for strict DB mode
   - [ ] Prevent legacy backend usage when enabled

## Acceptance Criteria

- DB-only backend (`db`) is selectable; commands operate solely on DB for these tasks.
- **CRITICAL**: Embeddings are generated from title + full spec content, not broken metadata fields.
- No runtime path reads `process/tasks.md`.
- Migration/import can populate tasks with `backend = db` across all 3 tables.
- Manual export command writes readable artifacts with a do-not-edit banner.
- Strict mode flag prevents using in-tree backends and fails fast when enabled.
- All 3 tables (tasks, task_specs, tasks_embeddings) work together seamlessly.

## Notes

- Future: add GI sync (pull-only first), field ownership, and webhooks.
- Future: consider switching IDs to `db#` and/or introducing alias resolution.
- **PRIORITY**: Fix the broken embedding generation BEFORE implementing new backend to avoid carrying forward the bug.