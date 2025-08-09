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
- ~~Temporary legacy acceptance (input-only) during migration; remove after cutover~~

## Success Criteria

- `minsky tasks list` shows qualified backend IDs correctly ✅
- `minsky tasks get md#367` works ✅
- ~~Post-migration: CLI accepts ONLY qualified IDs~~ ✅

## 🎯 Expanded Scope: Validation, Parsing, Retrieval

- ~~CLI schema validation must accept qualified IDs now; later flip to strict-only~~ ✅
- ~~Task list must preserve qualified IDs (no stripping)~~ ✅
- ~~Retrieval must resolve qualified IDs reliably~~ ✅

## Implementation Plan

1. ~~Migration command enhancements (default-on spec rename)~~ ✅
   - ~~Extend `tasks migrate` to:~~
     - ~~Rename numeric spec files `^\d+-.*\.md$` → `md#<id>-...` (backup and dry-run first)~~ ✅
     - ~~Update references in `process/tasks.md` accordingly~~ ✅
     - ~~Use markdown task backend path rules to avoid data loss~~ ✅
     - ~~Log mapping file for rollback~~ ✅

2. ~~Strict mode toggle (temporary)~~ ✅
   - ~~Add config flag `tasks.strictIds` (default false) using configuration system~~ ✅
   - ~~When true: `taskIdSchema` accepts ONLY `^[a-z-]+#\d+$`~~ ✅
   - ~~When false: keep current normalization (legacy accepted → normalized to md#)~~ ✅
   - ~~We will remove this toggle after full migration~~ ✅

3. **Parsing consolidation** ✅ **COMPLETED**
   - Ensure `taskFunctions.ts` and `taskConstants.ts` keep IDs qualified
   - Remove/avoid any normalization that strips backend prefixes
   - **Identify and consolidate the 3+ parsing implementations into single authority**

4. ~~Verification~~ ✅
   - ~~Tests for migration rename, list display, and strict-only acceptance (behind flag)~~ ✅
   - ~~Manual verification via `bun run ./src/cli.ts tasks migrate --dry-run` then apply~~ ✅

## Status Update

✅ MIGRATION COMPLETED
- Applied spec file renames with backup (numeric → `md#<id>-...`)
- Updated all links in `process/tasks.md` to qualified paths and `[md#id]` texts
- Verified end-to-end:
  - `tasks list` shows qualified IDs (e.g., `md#367`, `md#004`)
  - `tasks get md#367` returns the correct task
  - `tasks spec md#367` reads the correct spec file

✅ CLEANUP COMPLETED (STRICT-ONLY, NO TOGGLES)
- Removed permissive mode and the `tasks.strictIds` toggle; deleted `strict-mode-checker`
- Unified on `src/domain/tasks/task-id.ts`; removed legacy `unified-task-id.ts`
- Zod schemas strict-only (`taskIdSchema`, CLI `TaskParameters.taskId*`)
- Removed normalization utilities and legacy aliases:
  - Deleted `normalizeTaskId` usages across domain and adapters
  - Simplified `task-id-utils.ts` to `validateQualifiedTaskId` and helpers; removed `formatTaskIdForDisplay`
- Session layer hardened for qualified IDs only:
  - `SessionMultiBackendIntegration`: strict-only, removed `getDisplayTaskId` and legacy migration helpers
  - Kept strict `extractTaskIdFromSessionName` for `task-<qualified>` parsing in PR workflows
  - `session delete` resolves by `name` or qualified `task` via unified resolver
- Task domain cleanup:
  - `taskFunctions.ts` formats IDs strictly (no legacy decoration)
  - `taskConstants.ts` regex fixed for `[md#004]` and qualified-only parse
- Tests updated to strict-only and to use mock FS utilities (no real fs):
  - Session CLI/domain tests use `md#...`, removed mkdir/file IO
  - Removed legacy expectations and `ForStorage` alias; updated spies/mocks

📌 Naming and module cleanup
- Renamed module to `task-id` (no "unified"/"qualified" prefixes per boundary protocol)
- Removed dead code and temporary compatibility layers

📗 Documentation
- Converted remaining `[#id]` link texts to `[md#id]` in `process/tasks.md`
- This spec reflects strict-only policy: input == storage == display (qualified only)
