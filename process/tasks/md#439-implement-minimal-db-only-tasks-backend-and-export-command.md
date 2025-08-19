# Implement Minimal DB-Only Tasks Backend (db#) and Manual Export Command

Status: TODO
Priority: HIGH

## Summary

Introduce a minimal database-backed task backend (`backend = db`, task ID prefix `db#`) that treats the Postgres `tasks` table as the source of truth for both metadata and spec. Deprecate all reads of the monolithic `process/tasks.md`. Provide a manual export command to generate human-readable markdown artifacts, but do not perform exports automatically.

## Goals

- Create a new tasks backend type: `db` (ID prefix `db#`).
- Treat DB as SoT (metadata + spec) for this backend.
- Stop reading `process/tasks.md` entirely in runtime command paths.
- Reuse the existing migration/import flow to write tasks into the DB with `backend = db` instead of `markdown`.
- Implement a manual export command to generate read-only markdown artifacts for inspection/PRs (no inbound parsing).
- Add an optional strict mode to error on any usage/configuration of in-tree backends (markdown/json) while transitioning.

## Non-Goals (for this task)

- Field-level ownership policy, GI sync, or webhooks.
- Automatic/export-on-write behavior.
- Migration to new `db#` IDs across the codebase (links/aliases). For now, keep IDs as-is; revisit later as needed.

## Requirements

- Schema/config
  - Ensure `task_backend` enum includes `db`.
  - Allow tasks with `backend = db` to be created/read/updated.

- Backend/Adapter
  - Register new `db` task backend implementation.
  - All reads/writes for `db` backend go to/from DB only.
  - Remove any fallback reads of `process/tasks.md`.

- Migration/Import
  - Update existing `tasks migrate`/import path so that it can write records as `backend = db` (option, or default when strict mode is enabled).
  - Preserve idempotency and verification.

- Export (manual, not automatic)
  - `minsky tasks export --format markdown --out docs/tasks/` (or similar) to write per-task files.
  - Each file contains a prominent header: “GENERATED – DO NOT EDIT. Source of truth is the database.”
  - Stable formatting to minimize diffs; never read these files back.

- Guardrails (strict mode)
  - Config flag (e.g., `tasks.strictDbMode: true`) that:
    - Errors if markdown/json backends are configured or resolved for runtime operations.
    - Logs a single deprecation warning if legacy files are present; errors in strict mode.

## CLI/MCP Surface (initial)

- MCP
  - `tasks.spec.get(id)`
  - `tasks.spec.set(id, content[, ifMatchContentHash])` with dry-run and optimistic concurrency.
  - `tasks.meta.get/set` for DB-owned fields (optional in this task if already present; otherwise stub).

- CLI
  - `minsky tasks export --format markdown --out <dir>` (manual export only).
  - No automatic export on write.

## Acceptance Criteria

- DB-only backend (`db`) is selectable; commands operate solely on DB for these tasks.
- No runtime path reads `process/tasks.md`.
- Migration/import can populate tasks with `backend = db`.
- Manual export command writes readable artifacts with a do-not-edit banner.
- Strict mode flag prevents using in-tree backends and fails fast when enabled.

## Notes

- Future: add GI sync (pull-only first), field ownership, and webhooks.
- Future: consider switching IDs to `db#` and/or introducing alias resolution.
