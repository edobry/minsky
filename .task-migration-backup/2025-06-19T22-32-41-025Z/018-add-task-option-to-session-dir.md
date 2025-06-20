# Task #018: Add `--task` Option to `session dir` Command

## Context

The Minsky CLI's `session dir` command currently only accepts a session name as an argument, requiring users to already know the session name to get its directory path. However, in the Minsky workflow, users often know the task ID they're working on but need to look up the associated session before they can get its directory path. This two-step process is inefficient and could be simplified by adding a `--task` option to the `session dir` command, similar to how it's implemented in the `session get` command.

## Requirements

1. **CLI Behavior**

   - Modify the `session dir` command to accept an optional `--task` parameter:
     ```
     minsky session dir [session-name] [--task <task-id>]
     ```
   - If `--task` is provided without a session name:
     - Look up the session by its associated task ID
     - If a session is found, return its directory path
     - If no session is found, return an appropriate error message
   - If both a session name and `--task` are provided:
     - Return an error message explaining that only one should be used

2. **Implementation Details**

   - Reuse the existing logic from `SessionDB.getSessionByTaskId()` that was added for the `session get` command
   - Normalize the task ID format using the existing `normalizeTaskId` utility
   - Use the same error handling patterns as the `session get` command

3. **Backward Compatibility**

   - The command must continue to support looking up session directories by session name (without `--task`)

4. **Error Handling**
   - If no session exists for the given task ID, return a clear error message
   - If multiple sessions exist for the same task ID (which should be prevented by the system but could occur), return the directory for the first one found

## Implementation Steps

1. Update the `session dir` command in `src/commands/session/cd.ts`:

   - Add a `--task` option
   - Modify the command logic to handle looking up sessions by task ID
   - Implement error handling for the case where both session name and task ID are provided
   - Ensure the directory path is returned correctly

2. Update the tests to cover the new functionality:

   - Test looking up a session directory by task ID
   - Test error handling for non-existent task IDs
   - Test error handling for providing both session name and task ID

3. Update CLI help text to include the new option.

## Verification

- [ ] Can look up a session directory by its associated task ID using `minsky session dir --task <task-id>`
- [ ] Gets an appropriate error when looking up a non-existent task ID
- [ ] Can still look up session directories by name as before
- [ ] Gets an appropriate error when providing both session name and `--task`
- [ ] All relevant tests pass
- [ ] CLI help text is updated

## Work Log

- Not started

## Notes

- This enhancement improves the workflow for users who are continuing work on an existing task, making it easier to navigate to the associated session directory.
- It's particularly helpful when working in script-based workflows where the session directory path is needed for further operations.
