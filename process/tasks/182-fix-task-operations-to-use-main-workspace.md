# Task 182: Fix Task Operations to Use Main Workspace

## Status

NEW

## Priority

HIGH

## Category

BUG FIX

## Context

This task is Phase 1 of the solution identified in Task #157. Currently, task operations (status updates, creation, etc.) executed from session workspaces operate on the session's local copy of task files, causing synchronization issues where different workspaces show different task states.

## Root Cause

The `resolveWorkspacePath()` function in `src/domain/workspace.ts` returns the current directory for all operations:

```typescript
// Note: We're no longer redirecting to the upstream repository path when in a session
// This allows rules commands to operate on the current directory's rules
return checkPath; // Returns current directory!
```

While this is correct for rules operations, it breaks task operations which should always work on the main workspace.

## Requirements

1. **Modify Workspace Resolution for Task Operations Only**:

   - Add a `forTaskOperations` flag to `WorkspaceResolutionOptions` interface
   - When this flag is set, always resolve to the main workspace path
   - Preserve current behavior for all other operations (rules, files, etc.)

2. **Update Task Commands**:

   - Modify all task-related commands to pass `forTaskOperations: true`
   - Ensure TaskService uses the corrected workspace path
   - Commands affected:
     - `tasks status set`
     - `tasks status get`
     - `tasks create`
     - `tasks list`
     - `tasks get`
     - Any other task manipulation commands

3. **Maintain Backward Compatibility**:
   - Non-task operations must continue to work as before
   - Rules operations must still use the current directory
   - Session file operations must remain unchanged

## Implementation Steps

1. **Update WorkspaceResolutionOptions Interface**:

   ```typescript
   export interface WorkspaceResolutionOptions {
     workspace?: string;
     sessionWorkspace?: string;
     sessionRepo?: string;
     forTaskOperations?: boolean; // NEW FLAG
   }
   ```

2. **Modify resolveWorkspacePath Function**:

   ```typescript
   export async function resolveWorkspacePath(
     options?: WorkspaceResolutionOptions,
     deps: TestDependencies = {}
   ): Promise<string> {
     // For task operations, always use main workspace
     if (options?.forTaskOperations) {
       const sessionInfo = await getSessionFromWorkspace(process.cwd());
       if (sessionInfo) {
         // Resolve to main workspace from session info
         return resolveMainWorkspaceFromRepoUrl(sessionInfo.upstreamRepository);
       }
     }

     // Existing logic for other operations
     return checkPath;
   }
   ```

3. **Update Task Commands**:

   - Add `forTaskOperations: true` to workspace resolution in all task commands
   - Ensure TaskService receives and uses the corrected path

4. **Add Tests**:
   - Test task operations from session workspace resolve to main
   - Test non-task operations still use current directory
   - Test edge cases (not in session, invalid session, etc.)

## Verification

- [ ] Task status updates from session workspaces modify main workspace files
- [ ] Task creation from session workspaces creates tasks in main workspace
- [ ] Task list/get operations from sessions read from main workspace
- [ ] Rules operations still work on current directory
- [ ] File operations in sessions remain unchanged
- [ ] All existing tests pass
- [ ] New tests for workspace resolution logic pass

## Success Metrics

1. **Zero Task State Divergence**: Task operations from any workspace show identical results
2. **No Breaking Changes**: All non-task operations continue to work as before
3. **Performance**: No noticeable performance degradation
4. **Reliability**: Task operations work consistently regardless of execution context

## Notes

- This is a targeted fix that addresses the immediate synchronization issue
- It sets the foundation for the longer-term special workspace solution (Task #157)
- The fix should be minimal and focused only on task operations
- Consider adding debug logging to help diagnose any issues
