# Task #004: Add `--task` Option to `session get` Command

## Context

The Minsky CLI's session management allows sessions to be associated with tasks, but there is currently no direct way to query sessions by their associated task ID. This requires users to first list all sessions and then filter for the desired task ID using external tools like `jq`. Adding a `--task` option to the `session get` command would streamline this workflow and make it easier to find sessions associated with specific tasks.

## Requirements

1. **CLI Behavior**

   - Modify the `session get` command to accept an optional `--task` parameter:
     ```
     minsky session get [session-name] [--task <task-id>]
     ```
   - If `--task` is provided without a session name:
     - Look up sessions by their associated task ID
     - If a session is found, return its details
     - If no session is found, return an appropriate error message
   - If both a session name and `--task` are provided:
     - Return an error message explaining that only one should be used

2. **Backward Compatibility**

   - The command must continue to support looking up sessions by name (without `--task`)
   - All existing options (e.g., `--json`) should continue to work with the new `--task` option

3. **Error Handling**

   - If no session exists for the given task ID, return a clear error message
   - If multiple sessions exist for the same task ID (which should be prevented by the system but could occur), return the first one found with a warning

4. **Documentation**
   - Update CLI help text to describe the new option
   - Update README and other documentation to include the new functionality

## Implementation Steps

1. Update the `session get` command in `src/commands/session/get.ts`:

   - Add a `--task` option
   - Modify the command logic to handle looking up sessions by task ID
   - Implement error handling for the case where both session name and task ID are provided

2. Update the session lookup logic in the session domain module to support finding sessions by task ID.

3. Update tests to cover the new functionality.

4. Update documentation and CLI help text.

## Verification

- [x] Can look up a session by its associated task ID using `minsky session get --task <task-id>`
- [x] Gets an appropriate error when looking up a non-existent task ID
- [x] Can still look up sessions by name as before
- [x] Gets an appropriate error when providing both session name and `--task`
- [x] All options like `--json` work correctly with the new `--task` option
- [x] All relevant tests pass
- [x] Documentation and CLI help are updated

## Work Log

- 2025-04-29: Added `getSessionByTaskId` method to SessionDB class in src/domain/session.ts
- 2025-04-29: Updated session get command in src/commands/session/get.ts to support the --task option
- 2025-04-29: Added comprehensive tests for the --task option in src/commands/session/get.test.ts
- 2025-04-29: Updated README.md to include documentation for the new option
- 2025-04-29: Updated CHANGELOG.md to document the addition of the --task option

## Notes

- This enhancement improves the workflow for users who are continuing work on an existing task, making it easier to find the associated session.
- It's particularly helpful in the context of the Minsky workflow where task IDs are used to associate sessions with specific work items.
