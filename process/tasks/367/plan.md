# Task 367 Plan: Consolidate Multiple Task ID Parsing Implementations

## Objective

Unify task ID parsing and validation across the CLI and domain layers so that qualified backend IDs (e.g., `md#367`, `gh#123`) are accepted end-to-end and displayed consistently, while preserving legacy input formats (e.g., `#367`, `367`, `task#367`).

## Scope From Spec

- Task creation/storage already uses qualified IDs (e.g., `md#367`).
- Listing tasks currently ignores qualified IDs.
- CLI schema validation rejects qualified IDs.
- Retrieval by qualified ID fails.

## Success Criteria

- `minsky tasks list` displays IDs as qualified (e.g., `md#367`).
- `minsky tasks get md#367` works.
- All legacy inputs are accepted on input but normalized internally (PERMISSIVE IN, STRICT OUT).

## Current Artifacts to Review

- `process/tasks/md#367-consolidate-multiple-task-id-parsing-implementations.md` (spec) ✅
- `src/domain/tasks/unified-task-id.ts` (hash-style unified parser)
- `src/domain/tasks/backend-qualified-id.ts` (colon-style parser; legacy/alt)
- `src/domain/tasks/task-id-utils.ts` (normalizeForStorage: PERMISSIVE IN → STRICT OUT to `md#<n>`)
- `src/domain/tasks/taskConstants.ts` (regex + parsing for task lines)
- `src/domain/tasks/taskFunctions.ts` (markdown parsing; ensure it preserves qualified IDs)
- `src/adapters/shared/commands/tasks/*.ts` (CLI param schemas and validators)

## Risks / Known Issues

- Multiple ID systems exist: `backend#id` vs `backend:id`. Must standardize on `backend#id` per spec and adapt all call sites.
- CLI validators may enforce numeric-only IDs; must be updated to accept `^[a-z-]+#\d+$` as well as legacy numeric inputs.

## Proposed Design

- Canonical representation: `backend#<digits>` (e.g., `md#367`, `gh#12`).
- Input policy: PERMISSIVE IN (accept `md#367`, `#367`, `367`, `task#367`).
- Storage/Display policy: STRICT OUT (always `backend#<digits>`, default backend `md`).
- Single authority module: prefer `src/domain/tasks/task-id-utils.ts` to provide:
  - `normalizeTaskIdForStorage(userInput: string): string | null` (already exists) — ensure no regressions.
  - Add `isQualified(taskId: string): boolean` (calls unified parser).
  - Add `parseQualified(taskId: string)` → `{ backend, localId, full } | null`.
- Replace scattered parsing with calls into this authority module.

## Work Plan

1. Tests (add/extend bun:test):
   - CLI param acceptance for `tasks get` and session commands: `md#367`, `#367`, `367`, `task#367`.
   - Task list shows qualified IDs.
2. CLI schema/validation updates:
   - Update validators in `src/adapters/shared/commands/tasks/*` and common param schemas to accept qualified IDs.
3. Domain parsing consolidation:
   - Ensure `taskFunctions.ts` preserves qualified IDs (no normalization to legacy).
   - Ensure `taskConstants.ts` regex correctly extracts qualified IDs.
   - Remove or adapt `backend-qualified-id.ts` usages; migrate to `backend#id` or provide adapter.
4. Retrieval path:
   - Make `TaskService.getTask` and backends resolve both qualified and legacy IDs by normalizing to qualified internally.
5. Manual verification:
   - Use `bun run ./src/cli.ts tasks list` and `bun run ./src/cli.ts tasks get md#367` in session workspace.

## Deliverables

- Updated tests passing.
- Consolidated parsing utilities.
- CLI accepts qualified IDs; list shows qualified IDs.
- Changelog entry in root `CHANGELOG.md`.

## Open Questions

- Any other backends beyond `md` in current repo that must be validated? (gh?)
