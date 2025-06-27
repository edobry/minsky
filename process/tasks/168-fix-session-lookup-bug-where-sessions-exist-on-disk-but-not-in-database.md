# Fix Session Lookup Bug Where Sessions Exist on Disk But Not in Database

## Problem Description

Sessions created with `minsky session start <name>` are not properly registered in the session database, causing lookup failures when using session commands like `minsky session pr`.

**Current Symptoms:**

- `minsky session start error-message-improvements` succeeds and creates session directory
- `minsky session pr --title "..."` fails with "Session 'error-message-improvements' not found"
- Session directory exists at `~/.local/state/minsky/git/*/sessions/error-message-improvements`
- Session is not returned by `minsky sessions list`

## Status Update: Main Branch Integration ✅ COMPLETED

**Core functionality has been implemented in main branch** through commits:

- `512f789c`: Session self-repair in preparePr function
- `27ab24d7`: Session auto-detection in updateSessionFromParams
- `8a522101`: Task creation CLI bug fixes

**However, our task#168 implementation is superior in quality and needs to be preserved.**

## Implementation Quality Analysis

### Our Implementation vs Main Branch

**✅ Our Advantages:**

1. **Git Clone Bug Fix**: Prevents orphaned session directories (CRITICAL)
2. **Improved Self-Repair Logic**: More robust task ID extraction and error handling
3. **Better Auto-Detection**: Uses `getCurrentSession()` helper for consistency
4. **Comprehensive Test Coverage**: Integration tests that don't exist in main
5. **Superior Error Messages**: Multi-step actionable guidance (deferred for now)

**❌ Main Branch Limitations:**

- Still has git clone bug that creates orphaned directories
- Less robust self-repair implementation
- Missing comprehensive test coverage
- Basic error messages

## Reimplementation Plan ✅ IN PROGRESS

Since main branch has overlapping functionality, we're reimplementing our superior versions:

### Phase 1: Create New Branch from Main ✅ COMPLETED

- New branch: `task#168-reimplemented` from `origin/main`

### Phase 2: Apply Our Improvements (Non-Interactive)

#### 2.1 Fix Git Clone Bug (HIGH PRIORITY) 🔄 NEXT

- **File**: `src/domain/git.ts`
- **Change**: Move `mkdir(sessionsDir)` to happen ONLY when ready to clone
- **Impact**: Prevents orphaned session directories

#### 2.2 Improved Self-Repair Logic (MEDIUM PRIORITY)

- **File**: `src/domain/session.ts`
- **Change**: Use our more robust task ID extraction and error handling
- **Impact**: More reliable session recovery

#### 2.3 Better Auto-Detection (MEDIUM PRIORITY)

- **File**: `src/domain/session.ts`
- **Change**: Use `getCurrentSession()` helper instead of path parsing
- **Impact**: More consistent session detection

#### 2.4 Comprehensive Test Suite (LOW PRIORITY)

- **Files**: Add our integration tests
- **Change**: Port our test coverage that doesn't exist in main
- **Impact**: Better bug prevention

#### 2.5 Enhanced Error Messages (DEFERRED)

- **Reason**: Conflicts with other work in progress
- **Status**: Will be addressed in separate task

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

## Expected Behavior

When `minsky session start <name>` completes successfully:

1. Session directory should be created on disk ✅ (working)
2. Session metadata should be registered in database ✅ (working)
3. `minsky sessions list` should show the session ✅ (working)
4. `minsky session pr` should find the session ✅ (working in main)

## Acceptance Criteria

- ✅ Sessions created with `minsky session start` appear in `minsky sessions list`
- ✅ Session PR commands work immediately after session creation
- ✅ Both JSON file and adapter backends register sessions correctly
- ✅ Existing broken sessions can be recovered (database moved to correct location)
- ✅ Add test coverage for session creation → database registration flow
- ✅ Error handling: if database registration fails, session creation should fail
- 🔄 **NEW**: Superior implementation quality preserved from task#168 branch

## Implementation Summary

**Files Modified in Original Implementation:**

- `src/cli.ts` - Fixed CLI entry point detection
- `src/domain/git.ts` - Added debugging and fixed session directory cleanup
- `src/domain/session.ts` - Fixed database path and added debugging
- `src/types/node.d.ts` - Added missing process type declarations (reverted)

**Tests Added:**

- `src/domain/__tests__/session-lookup-bug-simple.test.ts` - TDD test for the bug
- `src/domain/__tests__/session-lookup-bug-integration.test.ts` - Integration test

**Reimplementation Strategy:**

- Non-interactive approach using manual code changes and direct commits
- Preserving superior quality while building on main branch foundation
- Skipping error message improvements to avoid conflicts with other work

## Priority

High - Core functionality exists in main, but critical quality improvements need preservation.

## Next Steps

1. Implement git clone bug fix on new branch
2. Apply improved self-repair logic
3. Add comprehensive test coverage
4. Validate all improvements work correctly
