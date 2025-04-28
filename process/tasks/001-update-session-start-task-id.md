# Task #001: Update `session start` Command to Support Task IDs

## Context

The Minsky CLI manages collaborative AI agent workflows using sessions and tasks. Currently, the `session start` command requires a session name. To improve traceability and workflow integration, the command should optionally accept a task ID, look up the task, and associate the session with it. This will allow sessions to be directly linked to tracked work items.

## Requirements

1. **CLI Behavior**
   - Command signature:
     ```
     minsky session start <session-name> --repo <repo-url-or-path> [--task <task-id>]
     ```
   - If `--task <task-id>` is provided:
     - Use the task ID as the session name (e.g., `task#001`).
     - Look up the task using the tasks domain module.
     - If the task does not exist, error out with a clear message.
     - If a session for this task already exists, error out and return the session name.
   - If `--task` is not provided, use the given `<session-name>` as before.

2. **Session Naming**
   - The session should have:
     - A full name: `<repo>/task#001`
     - A short name: `task#001` (used for the git branch)
   - Store the session using the short name in the session DB for consistency with existing logic.

3. **Session Database**
   - Continue using the existing `SessionDB` in `src/domain/session.ts`.
   - Store the task ID in the session record if the session is associated with a task.
   - Only store the task ID (not a snapshot of the task details).

4. **Task Lookup**
   - Use the existing tasks domain module for all task lookups and validation.
   - Do not duplicate task parsing logic in the command module.

5. **Single Task per Session**
   - Each session may only be associated with a single task.

6. **Error Handling**
   - If the task ID does not exist, error out.
   - If a session for the task already exists, error out and return the session name.
   - If the session name is already in use, error out as before.

7. **Backward Compatibility**
   - The command must continue to support starting a session with a freeform session name (without `--task`).

8. **Testing**
   - Add/modify tests to cover:
     - Starting a session with a task ID.
     - Starting a session with a freeform name.
     - Error handling for invalid/missing task IDs.
     - Error handling for duplicate sessions.

9. **Documentation**
   - Update CLI help and project documentation to describe the new behavior.

## Implementation Steps

1. Update the `session start` command in `src/commands/session/start.ts`:
   - Add a `--task <task-id>` option.
   - If `--task` is provided, use the task ID as the session name and perform task lookup.
   - Validate that the task exists and that no session for this task already exists.
   - Store the task ID in the session record.

2. Update the `SessionRecord` type in `src/domain/session.ts` to include an optional `taskId` field.

3. Update the session creation logic to use the short name (`task#001`) for the branch and session DB.

4. Ensure all error cases are handled as specified.

5. Update or add tests for the new behavior.

6. Update documentation and CLI help output.

## Verification

- [x] Can start a session with a freeform name as before.
- [x] Can start a session with `--task <task-id>`, and the session is named after the task.
- [x] If the task does not exist, the command errors out with a clear message.
- [x] If a session for the task already exists, the command errors out and returns the session name.
- [x] The session DB record includes the `taskId` if the session is associated with a task.
- [x] All relevant tests pass.
- [x] Documentation and CLI help are updated.

## Notes

- The tasks domain module is the single source of truth for task lookup and validation.
- The session DB is the single source of truth for session existence and metadata.
- This change maintains backward compatibility and enforces a one-to-one mapping between sessions and tasks when using `--task`. 
