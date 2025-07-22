# Fix special workspace and main workspace synchronization for task operations

## Summary

This PR resolves synchronization issues between the special workspace and main workspace for task operations, fixing the core problem where task files were created in both locations but task commands couldn't find them due to database synchronization failures.

## Root Cause Analysis

- **Problem**: Auto-commit functionality was incompatible with special workspace operations
- **Issue**: Regular git commands don't properly handle SpecialWorkspaceManager's atomic operations
- **Impact**: Tasks created correctly but changes weren't synchronized between workspaces

## Solution Implemented

### New Utility: `src/utils/task-workspace-commit.ts`
- **Smart workspace detection** - automatically identifies special vs. regular workspace
- **Proper special workspace handling** - uses SpecialWorkspaceManager for atomic operations
- **Upstream synchronization** - ensures changes sync from special to main workspace before commits
- **Fallback support** - maintains backward compatibility with regular workspace operations

### Updated Task Commands Integration
- Modified all task command functions (`createTask`, `setTaskStatus`, `deleteTask`) to use new synchronization mechanism
- Replaced direct `autoCommitTaskChanges` calls with intelligent `commitTaskChanges` wrapper
- Added proper error handling and workspace-aware commit logic

## Testing

- Created comprehensive test suite with 10 focused test cases
- Tests cover function interface, workspace detection, error handling, and backend compatibility
- Verifies both regular workspace and special workspace path handling
- All tests pass with proper Promise<boolean> return validation

## Verification

✅ **Cross-workspace task visibility**: Tasks created in special workspace now visible in main workspace
✅ **Status synchronization**: Task status updates properly sync between workspaces
✅ **Backward compatibility**: Regular workspace operations unchanged
✅ **Error handling**: Graceful fallback for edge cases

## Files Changed

- `src/utils/task-workspace-commit.ts` - New intelligent auto-commit utility
- `src/domain/tasks/taskCommands.ts` - Updated to use new synchronization mechanism
- `src/utils/__tests__/task-workspace-commit.test.ts` - Comprehensive test suite
- `process/tasks/310-fix-special-workspace-and-main-workspace-synchronization-for-task-operations.md` - Updated task specification

This resolves the synchronization issues identified in task #310 where task operations in special workspace failed to properly sync changes back to main workspace.
