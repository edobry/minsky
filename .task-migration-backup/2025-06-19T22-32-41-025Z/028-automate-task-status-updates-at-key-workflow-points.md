# Task #028: Automate Task Status Updates at Key Workflow Points

## Context

Currently, developers must manually update task statuses at different points in the workflow using `minsky tasks status set`. This is error-prone and frequently overlooked, especially at the completion of tasks where setting a status to IN-REVIEW is required. The workflow documentation has been updated to emphasize these status changes, but an automated approach would ensure consistent status tracking.

Task statuses should be automatically updated at two critical points:

1. When a session is started for a task (set to IN-PROGRESS)
2. When a PR is created for a task (set to IN-REVIEW)

Automating these status updates will ensure proper tracking of task progress and eliminate a common source of workflow errors.

## Requirements

1. **Automated Status Update When Starting Work**

   - Enhance the `session start` command to:
     - Automatically update the task status to IN-PROGRESS when a session is created with `--task`
     - Add a `--no-status-update` flag to skip the automatic status update if needed
     - Output a confirmation message about the status update

2. **Automated Status Update When Creating PRs**

   - Enhance the `git pr` command to:
     - Automatically update the associated task status to IN-REVIEW after generating a PR
     - Add a `--no-status-update` flag to skip the automatic status update if needed
     - Show feedback about the status update operation

3. **Task ID Resolution**

   - Both commands should be able to determine the task ID:
     - From the session metadata for an existing session
     - From the `--task` parameter when provided
     - By parsing the branch name if it follows the task#XXX format
   - Provide clear error messages if no task ID can be determined

4. **Integration with TaskService**

   - Use the existing TaskService for status updates
   - Ensure all repo resolution logic is consistent
   - Maintain the command-line interface for manual status updates
   - Add appropriate error handling for status update failures

5. **Logging and Feedback**
   - Log each automated status update with:
     - The task ID
     - The previous status
     - The new status
     - The command that triggered the update
   - Provide clear feedback in command output
   - Support the existing `--debug` flag for detailed logging

## Implementation Steps

1. [ ] Update the SessionService domain module:

   - [ ] Add task status update logic to the startSession method
   - [ ] Add appropriate parameters to control automatic status updates
   - [ ] Implement task ID resolution logic
   - [ ] Add error handling for status update failures

2. [ ] Update the GitService domain module:

   - [ ] Add task status update logic to the pr method
   - [ ] Add resolution logic to determine the associated task ID
   - [ ] Add parameters to control automatic status updates
   - [ ] Implement status update confirmation

3. [ ] Update the session start command:

   - [ ] Add `--no-status-update` flag to Commander.js options
   - [ ] Pass the status update preference to the domain module
   - [ ] Handle and display status update results
   - [ ] Update command help text to document new behavior

4. [ ] Update the git pr command:

   - [ ] Add `--no-status-update` flag to Commander.js options
   - [ ] Pass the status update preference to the domain module
   - [ ] Handle and display status update results
   - [ ] Update command help text to document new behavior

5. [ ] Add comprehensive tests:

   - [ ] Test automatic status updates for session start
   - [ ] Test automatic status updates for git pr
   - [ ] Test --no-status-update flag behavior
   - [ ] Test error handling for status update failures
   - [ ] Test task ID resolution from different sources

6. [ ] Update documentation:

   - [ ] Update README.md to document the automated status updates
   - [ ] Update the minsky-workflow.mdc rule
   - [ ] Update command help text

7. [ ] Update the CHANGELOG.md

## Work Log

- 2023-05-09: Implemented the core functionality for automating task status updates at key workflow points:
  - Enhanced `startSession` function to support updating task status to IN-PROGRESS
  - Added `--no-status-update` flag to session start command
  - Implemented task status update in GitService's pr method
  - Added `--no-status-update` flag to git pr command
  - Implemented task ID resolution from session metadata and branch name
  - Added proper status update reporting in command output
  - Created tests for the new functionality

## Verification

- [x] Starting a session with `--task` automatically updates the task status to IN-PROGRESS
- [x] The `--no-status-update` flag successfully prevents automatic status updates when needed
- [x] The git pr command correctly updates the task status to IN-REVIEW
- [x] Both commands provide clear feedback about the status update operation
- [x] Error handling works correctly when a task ID cannot be determined
- [x] Task ID is correctly resolved from session metadata, parameter, or branch name
- [x] All tests pass
- [x] Documentation is updated
- [x] CHANGELOG.md is updated

## Notes

This enhancement builds upon task #010 ("Enhance `git pr` command to create GitHub PRs and update task status"), which already includes part of the task status update functionality for the git pr command. The implementation should ensure compatibility with that upcoming feature.
