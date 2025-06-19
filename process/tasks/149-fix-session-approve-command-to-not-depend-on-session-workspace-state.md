# Task #149: Fix session approve command to not depend on session workspace state

## Context

The `session approve` command currently has a design flaw where it operates on the session workspace during the approval process, which causes failures when there are uncommitted changes in the session workspace.

## Problem

When running `session approve`, the command fails with:

```
Command execution failed {"error":"Command failed: git checkout main\nerror: Your local changes to the following files would be overwritten by checkout:\n\tprocess/tasks.md\nPlease commit your changes or stash them before you switch branches.\nAborting\n","command":"git checkout main","workdir":"/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#128"}
```

This is incorrect behavior because:

1. The session workspace state should be irrelevant during approval
2. All work is already captured in the prepared merge commit on the `pr/task#*` branch
3. The approval process should only need to operate on the main repository

## Current (Incorrect) Workflow

1. `session approve` tries to operate on session workspace
2. Attempts `git checkout main` in session workspace
3. Fails if there are uncommitted changes
4. Requires manual intervention to commit/stash changes

## Desired (Correct) Workflow

1. `session approve` operates only on main repository
2. Fast-forward merges `pr/task#*` branch into `main`
3. Updates task status to `DONE`
4. Cleans up PR branch
5. Session workspace state is completely irrelevant

## Requirements

1. **Decouple approval from session workspace**: The approve command should not depend on or modify the session workspace state
2. **Focus on main repository**: All approval operations should happen in the main repository only
3. **Preserve existing functionality**: Task status updates and PR cleanup should still work
4. **Maintain safety**: Ensure the prepared merge commit is valid before merging

## Implementation Steps

1. [ ] **Analyze current `session approve` implementation** in `src/domain/session.ts`
2. [ ] **Identify session workspace dependencies** in the approval flow
3. [ ] **Refactor to operate on main repository only**:
   - [ ] Change working directory to main repository
   - [ ] Remove session workspace checkout operations
   - [ ] Ensure all git operations target main repo
4. [ ] **Update task status handling** to not require session workspace
5. [ ] **Test with various session workspace states** (clean, dirty, conflicted)
6. [ ] **Update documentation** to reflect the corrected workflow

## Verification

- [ ] `session approve` works when session workspace has uncommitted changes
- [ ] `session approve` works when session workspace is on any branch
- [ ] `session approve` works when session workspace is in a conflicted state
- [ ] All existing functionality (task status update, PR cleanup) still works
- [ ] No regression in approval safety checks
- [ ] Session workspace state remains unchanged after approval

## Files to Modify

- `src/domain/session.ts` - Main approval logic
- `src/domain/git.ts` - Git operations (if needed)
- Tests for session approval workflow

## Priority

**High** - This blocks the normal workflow and requires manual workarounds
