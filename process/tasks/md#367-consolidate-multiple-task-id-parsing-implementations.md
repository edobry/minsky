# Consolidate Multiple Task ID Parsing Implementations

## Context

TECHNICAL DEBT: Multiple inconsistent task parsing implementations prevent qualified backend IDs (md#367, gh#123) from appearing in task list.

## Problem

- Task creation works: generates md#367 ✅
- File storage works: saves [md#367] ✅
- Manual regex test works: extracts md#367 ✅
- Task list fails: completely ignores qualified IDs ❌

## Root Cause

At least 3 different parsing implementations:

1. src/domain/tasks/taskFunctions.ts (task list uses this)
2. src/domain/tasks/markdownTaskBackend.ts (task creation uses this)
3. src/domain/tasks/markdown-task-backend.ts (alternative implementation)

## Evidence

Task md#367 exists in process/tasks.md but invisible in `minsky tasks list`

## Required Fix

Consolidate all parsing into single unified implementation that supports:

- Qualified format: md#123, gh#456 (STRICT)
- Temporary legacy acceptance (input-only) during migration; remove after cutover

## Success Criteria

- `minsky tasks list` shows qualified backend IDs correctly
- `minsky tasks get md#367` works
- Post-migration: CLI accepts ONLY qualified IDs

## 🎯 Expanded Scope: Validation, Parsing, Retrieval

- CLI schema validation must accept qualified IDs now; later flip to strict-only
- Task list must preserve qualified IDs (no stripping)
- Retrieval must resolve qualified IDs reliably

## Implementation Plan

1. Migration command enhancements (default-on spec rename)
   - Extend `tasks migrate` to:
     - Rename numeric spec files `^\d+-.*\.md$` → `md#<id>-...` (backup and dry-run first)
     - Update references in `process/tasks.md` accordingly
     - Use markdown task backend path rules to avoid data loss
     - Log mapping file for rollback

2. Strict mode toggle (temporary)
   - Add config flag `tasks.strictIds` (default false) using configuration system
   - When true: `taskIdSchema` accepts ONLY `^[a-z-]+#\d+$`
   - When false: keep current normalization (legacy accepted → normalized to md#)
   - We will remove this toggle after full migration

3. Parsing consolidation
   - Ensure `taskFunctions.ts` and `taskConstants.ts` keep IDs qualified
   - Remove/avoid any normalization that strips backend prefixes

4. Verification
   - Tests for migration rename, list display, and strict-only acceptance (behind flag)
   - Manual verification via `bun run ./src/cli.ts tasks migrate --dry-run` then apply

## Decisions

- Rename numeric spec files to `md#<id>-...` universally
- `md` is the universal default for legacy IDs

## Deliverables

- Enhanced migration with spec rename and safe backups
- Config toggle `tasks.strictIds` and wiring in `taskIdSchema`
- Updated tests and docs
