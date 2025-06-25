# Fix Session Lookup Bug Where Sessions Exist on Disk But Not in Database

## Problem Description

Sessions created with `minsky session start <name>` are not properly registered in the session database, causing lookup failures when using session commands like `minsky session pr`.

**Current Symptoms:**

- `minsky session start error-message-improvements` succeeds and creates session directory
- `minsky session pr --title "..."` fails with "Session 'error-message-improvements' not found"
- Session directory exists at `~/.local/state/minsky/git/*/sessions/error-message-improvements`
- Session is not returned by `minsky sessions list`

## Root Cause Analysis ✅ COMPLETED

**Primary Issues Identified and Fixed:**

1. **CLI Entry Point Failure**: CLI commands were silently failing due to incorrect `import.meta.main` detection

   - **Fixed**: Updated `cli.ts` to use proper entry point detection
   - **Result**: All CLI commands now provide proper output and error handling

2. **Database Location Mismatch**: SessionDB was looking in wrong location

   - **Issue**: Database created at `~/.local/state/minsky/minsky/session-db.json` but code expected `~/.local/state/minsky/session-db.json`
   - **Fixed**: Moved database to correct location and verified path consistency
   - **Result**: Session lookup now works correctly

3. **Session Directory Creation Bug**: Original bug where directories created before git operations
   - **Fixed**: Modified `GitService.clone` to create directories after validation and cleanup on failure
   - **Result**: No more orphaned session directories when git clone fails

## Current Status ✅ CORE ISSUES RESOLVED

- ✅ Sessions can be found in database (`minsky sessions list` works)
- ✅ CLI commands provide proper output and error handling
- ✅ Session directories are properly cleaned up on git failures
- ✅ TDD tests validate the fixes work correctly
- 🔄 `session pr` command has remaining database lookup issues to investigate

## Expected Behavior

When `minsky session start <name>` completes successfully:

1. Session directory should be created on disk ✅ (working)
2. Session metadata should be registered in database ✅ (working)
3. `minsky sessions list` should show the session ✅ (working)
4. `minsky session pr` should find the session 🔄 (partially working - needs investigation)

## Remaining Investigation Required

The `session pr` command still encounters session lookup issues despite the database fixes. This suggests:

1. **Multiple SessionDB instances**: Different parts of the code may be creating separate SessionDB instances
2. **Dependency injection issues**: The `preparePrFromParams` function may not be using the same database instance
3. **Context-specific database access**: Session workspace vs main workspace database access patterns

## Acceptance Criteria

- ✅ Sessions created with `minsky session start` appear in `minsky sessions list`
- 🔄 Session PR commands work immediately after session creation (needs investigation)
- ✅ Both JSON file and adapter backends register sessions correctly
- ✅ Existing broken sessions can be recovered (database moved to correct location)
- ✅ Add test coverage for session creation → database registration flow
- ✅ Error handling: if database registration fails, session creation should fail

## Implementation Summary

**Files Modified:**

- `src/cli.ts` - Fixed CLI entry point detection
- `src/domain/git.ts` - Added debugging and fixed session directory cleanup
- `src/domain/session.ts` - Fixed database path and added debugging
- `src/types/node.d.ts` - Added missing process type declarations (reverted)

**Tests Added:**

- `src/domain/__tests__/session-lookup-bug-simple.test.ts` - TDD test for the bug
- `src/domain/__tests__/session-lookup-bug-integration.test.ts` - Integration test

## Next Steps

Continue investigating the `session pr` command database lookup issue to complete the fix.

## Priority

High - Core issues resolved, remaining edge case needs completion.
