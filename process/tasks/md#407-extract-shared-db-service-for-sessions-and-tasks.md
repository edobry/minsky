# Extract Shared Database Service for Sessions, Tasks, and Embeddings

## Status

BACKLOG

## Priority

HIGH

## Context

Current storage uses a session-focused `DatabaseStorage<SessionRecord, SessionDbState>` with backends for SQLite and PostgreSQL via Drizzle. Task md#253 (embeddings-based similarity search) needs a persistent vector store (pgvector) and metadata linkage to tasks across backends. Task #315 asserts an external metadata DB pattern and reuse of existing database infrastructure, but the codebase does not yet expose a generalized, shared DB entry point usable by multiple domains (sessions, tasks, embeddings).

Short-term directive: reuse the session DB for task metadata and embeddings to deliver md#253 quickly. Long-term: extract a shared DB layer that cleanly supports sessions, tasks/metadata, and embeddings with proper migrations and extension checks.

## Goals

1. Provide a single shared DB access layer ("DbService") usable by multiple domains (sessions, tasks, embeddings)
2. Centralize connection management, migrations, and extension validation (e.g., pgvector)
3. Keep configuration simple: for now mirror sessiondb config; later introduce top-level `db` config if needed
4. Unblock md#253 by enabling creation and use of a `task_embeddings` table in PostgreSQL

## Requirements

### Core Abstraction

- Define `DbService` with:
  - `getSql()` → underlying client (postgres.js) when pg is used
  - `getDrizzle()` → Drizzle instance
  - `getBackendType()` → "sqlite" | "postgres"
  - `initialize()` → run migrations/DDL, ensure extensions (pgvector)
  - `close()` → close/pool teardown

### Configuration

- For now, source from existing sessiondb configuration (sqlite/postgres)
- Provide helper `getSharedDb()` that returns a singleton per-process instance keyed by backend/conn
- Future: allow independent `[db]` block to decouple from sessiondb without breaking existing setups

### Migrations and Schemas

- Add Drizzle schemas for embeddings table(s):
  - `task_embeddings`:
    - `id` (uuid or text)
    - `qualified_task_id` (text) – e.g., `md#253`, `gh#123`
    - `backend` (text) – optional; if needed for routing
    - `dimension` (integer)
    - `embedding` – `vector(<dimension>)` in Postgres (pgvector)
    - `created_at`, `updated_at`
    - unique on (`qualified_task_id`)
- PostgreSQL:
  - Ensure `CREATE EXTENSION IF NOT EXISTS vector` (pgvector)
  - Provide SQL migrations for table + optional IVFFlat/HNSW indexes
- SQLite (future/backport):
  - Stub schema; optional local vector alternative (not blocking md#253)

### Usage Patterns

- md#253 will consume `DbService` for vector storage via a `VectorStorage` implementation
- Task metadata (per #315 direction) can reuse the same service for relational tables when introduced

### Testing

- Unit tests for `DbService` initialization and backend selection
- PG-only tests for embeddings schema creation (skipped if PG unavailable)
- Mocks for Drizzle/clients where appropriate

## Deliverables

- `src/domain/storage/shared-db.ts` – shared DB service abstraction and factory
- `src/domain/storage/schemas/task-embeddings.ts` – Drizzle schema(s)
- `src/domain/storage/migrations/pg/*` – SQL migrations for embeddings + pgvector checks
- Basic docs and wiring notes in md#253 about using the shared DB for embeddings

## Acceptance Criteria

- A single `DbService` can be obtained and used across sessions and tasks code paths
- Running initialization on PostgreSQL creates/validates pgvector and `task_embeddings`
- md#253 can store and query embeddings via a `VectorStorage` that uses the shared DB
- Clear migration/extension errors with actionable guidance when prerequisites are missing

## Non-Goals (for this task)

- Implementing full task metadata relational model (tracked separately)
- SQLite vector support (optional follow-up)
