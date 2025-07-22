# Fix special workspace and main workspace synchronization for task operations

## Context

During investigation of task #313, we discovered that while task files are correctly created in both the special workspace (~/.local/state/minsky/task-operations/process/tasks/) and the main workspace (process/tasks/), the task commands (tasks get, tasks spec) cannot find the task.

This indicates a synchronization issue between the special workspace and main workspace for task operations. Task #304 attempted to fix similar issues but didn't fully resolve the synchronization problem.

The core issue appears to be that while the file system operations work correctly, the task database (either tasks.md or tasks.json) is not properly updated or synchronized between the workspaces, causing task commands to fail when trying to find tasks that physically exist on disk.

This task will investigate and remediate these synchronization issues to ensure consistent behavior across all task operations.

## Requirements

## Solution

## Notes
