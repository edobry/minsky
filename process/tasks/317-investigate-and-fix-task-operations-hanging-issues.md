# Investigate and fix task operations hanging issues

## Context

# Investigate and Fix Task Operations Hanging Issues

## Context

Task operations (particularly after they output) have been taking a very long time and sometimes hanging. This issue needs to be investigated and fixed to improve the user experience and system reliability.

## Problem Statement

Task operations like `minsky tasks get`, `minsky tasks spec`, `minsky tasks create`, and others have been observed to:

1. Complete their primary operation successfully (outputting the expected result)
2. Then hang for an extended period before returning control to the user
3. Sometimes requiring manual termination (Ctrl+C)

This behavior significantly degrades the user experience and can lead to confusion about whether commands have completed successfully.

## Investigation Areas

### 1. Auto-Commit Operations

The most likely culprit is the auto-commit functionality added in Task #303. This feature automatically commits and pushes changes after task operations when using the markdown backend. The implementation may have issues:

- **Git operations without proper timeouts**: Auto-commit may be performing git operations that hang
- **Synchronization with special workspace**: The special workspace system may have synchronization issues
- **Error handling**: Error handling in auto-commit may not properly terminate operations

### 2. Special Workspace Synchronization

Task #310 identified issues with special workspace and main workspace synchronization:

- Files are created correctly in both workspaces
- But task commands cannot find tasks that physically exist on disk
- This may cause additional lookups or retries that hang

### 3. Performance Monitoring

The `SessionDbHealthMonitor` and other monitoring systems may be causing performance issues:

- Excessive logging
- Metric collection that blocks the main thread
- Cleanup operations that run synchronously

### 4. File System Operations

File system operations may be causing issues:

- Lack of proper timeouts on file operations
- Race conditions between operations
- Lock contention between processes

## Technical Investigation Plan

1. **Profiling Task Operations**:

   - Add timing instrumentation around key operations
   - Identify which specific operations are causing delays
   - Measure time spent in auto-commit vs. primary operations

2. **Git Operation Analysis**:

   - Review all git operations in auto-commit
   - Ensure all git operations use timeout-aware utilities (`execGitWithTimeout`, etc.)
   - Check for unnecessary git operations or optimizations

3. **Special Workspace Audit**:

   - Verify synchronization between special workspace and main workspace
   - Check for redundant operations or unnecessary git operations
   - Review error handling and recovery mechanisms

4. **File System Operation Review**:
   - Ensure all file system operations have proper error handling
   - Check for synchronous operations that could be made asynchronous
   - Review file locking mechanisms

## Solution Requirements

1. **Performance Improvements**:

   - Task operations should complete within a reasonable time frame (< 2 seconds)
   - No hanging or blocking operations after primary task is complete
   - Clear feedback to user when operations are in progress

2. **Reliability Enhancements**:

   - All git operations must have proper timeouts
   - Graceful error handling for all operations
   - No silent failures or hangs

3. **User Experience**:
   - Clear indication when operations are complete
   - Option to disable auto-commit if it causes performance issues
   - Consistent behavior across all task operations

## Implementation Plan

1. **Diagnostic Phase**:

   - Add detailed logging and timing around task operations
   - Create a test harness to reproduce the hanging issues
   - Identify specific components causing delays

2. **Fix Implementation**:

   - Apply timeout protection to all git operations
   - Optimize or defer auto-commit operations
   - Improve error handling and recovery mechanisms

3. **Validation**:
   - Verify performance improvements across all task operations
   - Ensure no regressions in functionality
   - Test in various environments and scenarios

## Success Criteria

- All task operations complete within 2 seconds
- No hanging issues observed after primary operation completes
- Auto-commit functionality works correctly without causing delays
- Special workspace and main workspace remain properly synchronized
- Clear error messages for any failures

## Related Tasks

- Task #303: Improve task operations workflow with auto-commit for markdown backend
- Task #304: Fix special workspace auto-commit sync issue
- Task #310: Fix special workspace and main workspace synchronization for task operations
- Task #294: Audit codebase for git command timeout issues and create eslint rule

## Requirements

## Solution

## Notes
