# mt#238 Implementation Plan: Task Relationships MVP (with uuid id)

## Scope (MVP)

- Single edge type: depends (A depends on B)
- Store edges in `task_relationships` with UUID PK + unique(from, to)
- Qualified IDs only (e.g., `md#123`, `db#200`) – no FKs across backends
- Basic service APIs and minimal CLI/MCP surface

## Deliverables

1. Database migration (Postgres)

   - Table: `task_relationships`
     - `id uuid primary key default gen_random_uuid()`
     - `from_task_id text not null`
     - `to_task_id text not null`
     - `created_at timestamptz not null default now()`
     - `updated_at timestamptz not null default now()`
     - Constraints:
       - `check (from_task_id <> to_task_id)`
       - `unique (from_task_id, to_task_id)` (MVP: single type)
     - Indexes: `(from_task_id)`, `(to_task_id)`

2. Drizzle schema

   - Define model + Zod types
   - Export typed helpers for queries

3. Domain service: `TaskGraphService`

   - `addDependency(fromId, toId)` → creates edge (idempotent)
   - `removeDependency(fromId, toId)` → deletes if exists
   - `listDependencies(taskId)` → returns prerequisites (outgoing edges)
   - `listDependents(taskId)` → returns dependents (incoming edges)
   - (Future) `validateNoCycles()` – out of MVP unless trivial
   - Input validation: qualified ID format, self-edge prevention

4. MCP tools

   - `tasks.relationships.add { fromTaskId, toTaskId }`
   - `tasks.relationships.remove { fromTaskId, toTaskId }`
   - `tasks.relationships.list { taskId, direction: "deps" | "dependents" }`

5. CLI commands (thin wrappers)

   - `minsky tasks deps add <task> <depends-on>`
   - `minsky tasks deps rm <task> <depends-on>`
   - `minsky tasks deps list <task>`

6. Tests

   - Unit: service behaviors (idempotency, listing, validation)
   - Integration: MCP and CLI tool flows

7. Docs/Changelog
   - Update `CHANGELOG.md` (session workspace)
   - Minimal help text for CLI/MCP

## Non-goals (MVP)

- Multiple relationship types (can add `type` enum later)
- Hierarchy-specific helpers (`parent`, `subtasks`)
- Cycle detection enforcement (beyond self-edge) unless trivial
- Cross-backend FK constraints (IDs are qualified strings)

## Phased Steps

1. Migration + Drizzle schema
2. Implement `TaskGraphService`
3. Wire MCP tools
4. Add CLI wrappers
5. Tests (unit first, then integration)
6. Docs + changelog, commit/push

## Risk/Notes

- Pre-commit hooks are strict; keep changes scoped to new files + minor registrations
- Use qualified IDs consistently; rely on upstream resolvers for existence if needed
- Add `type` column + enum later without breaking stored edges
