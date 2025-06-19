# Task 026: Fix Task Spec Paths

## Problem Statement

After moving task specification files from their subdirectories to the root `process/tasks` directory with standardized names, the `tasks get` command is showing incorrect `specPath` values. The paths need to be updated to reflect the new standardized file locations.

## Context

Task specs were previously stored in subdirectories (e.g., `process/tasks/012/spec.md`) but have been moved to the root tasks directory with standardized names (e.g., `process/tasks/012-add-session-update-command.md`). However, the task database or configuration still references the old paths.

## Requirements

1. **Update Task Spec Paths**

   - Identify all tasks with incorrect spec paths
   - Update paths to point to the standardized filenames in `process/tasks` directory
   - Ensure paths are relative to workspace root
   - Handle both existing and missing spec files gracefully

2. **Validation**

   - Verify each spec file exists at the new path
   - Ensure `tasks get` command returns correct paths
   - Handle edge cases (missing files, malformed paths)

3. **Testing**
   - Add tests to verify spec path resolution
   - Test edge cases and error handling
   - Ensure backwards compatibility

## Implementation Steps

1. [ ] Analyze current task spec path storage:

   - [ ] Identify where spec paths are stored
   - [ ] Document current path resolution logic

2. [ ] Implement path update logic:

   - [ ] Create function to generate standardized spec paths
   - [ ] Add validation for file existence
   - [ ] Update storage mechanism with new paths

3. [ ] Add tests:

   - [ ] Test path generation
   - [ ] Test file existence validation
   - [ ] Test edge cases

4. [ ] Update documentation:
   - [ ] Document new spec path format
   - [ ] Update relevant command documentation

## Verification

1. [ ] All task spec paths follow the standardized format:

   - `process/tasks/<id>-<kebab-case-title>.md`

2. [ ] `tasks get` command shows correct paths:

   ```bash
   $ minsky tasks get 012 --json
   {
     "id": "#012",
     "specPath": "process/tasks/012-add-session-update-command.md",
     ...
   }
   ```

3. [ ] All tests pass
4. [ ] Documentation is updated

## Remaining Work

After implementing the primary task requirements, there are 15 additional failing tests that need to be fixed:

1. Repository Path Resolution Tests (2 failures)
2. Git Service Tests (3 failures)
3. Session Command Tests (10 failures)

These failures may be indirectly related to the task spec path changes and need to be resolved for full completion of this task.
