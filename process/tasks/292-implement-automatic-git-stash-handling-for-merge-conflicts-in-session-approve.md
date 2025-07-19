# Implement automatic git stash handling for merge conflicts in session approve

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Problem

When running `minsky session approve --task 061`, the command failed with:

```
Command execution failed {"error":"Command failed: git merge --ff-only pr/task#061\nerror: Your local changes to the following files would be overwritten by merge:\n\tprocess/tasks.md\nPlease commit your changes or stash them before you merge.\nAborting\n","command":"git merge --ff-only pr/task#061","workdir":"/Users/edobry/Projects/minsky"}
```

The git merge operation failed because local changes to `process/tasks.md` would be overwritten by the merge. Git suggests to either commit the changes or stash them before the merge.

## Goal

Explore and implement automatic `git stash` handling in the session approve workflow to gracefully handle local changes that would conflict with merge operations.

## Technical Requirements

1. **Detection**: Detect when local changes would be overwritten by a merge
2. **Automatic Stashing**: Automatically stash local changes before attempting merge
3. **Restoration Strategy**: Determine when and how to restore stashed changes
4. **Error Handling**: Handle cases where stash restoration fails due to conflicts
5. **User Feedback**: Provide clear feedback about stashing operations

## Implementation Considerations

### Stashing Strategy Options
- **Conservative**: Always stash before merge, restore after
- **Smart**: Only stash if merge would fail, selective restoration
- **Interactive**: Prompt user for stash decisions

### Conflict Resolution
- Handle cases where restoring stashed changes creates new conflicts
- Provide guidance for manual conflict resolution
- Consider leaving stashed changes for manual handling in complex cases

### Integration Points
- Session approve workflow (`minsky session approve`)
- Git merge operations in session management
- Error handling in git commands

## Acceptance Criteria

1. ✅ Session approve can automatically handle local changes using git stash
2. ✅ User receives clear feedback about stashing operations
3. ✅ Stashed changes are appropriately restored when safe
4. ✅ Complex conflict scenarios are handled gracefully
5. ✅ Original functionality is preserved for clean merge cases

## Files to Investigate

- `src/domain/session/` - Session management logic
- `src/domain/git/` - Git operations and merge handling
- Session approve command implementation
- Git merge conflict detection and handling

## Research Questions

1. When should stashing be automatic vs. user-prompted?
2. How to detect if restoring stashed changes will create conflicts?
3. Should stashed changes be automatically restored or left for manual handling?
4. How to integrate with existing git workflow and error handling?

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
