# Update `session start` Command to Support Task IDs

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

## Work Log

### Current State (as of last update)

**✅ Functionality**

- The `minsky session start` command now accepts an optional session name when using `--task`.
- If no session name is provided, it generates one based on the task ID.
- The command and its business logic are implemented and tested in the session directory.

**✅ Documentation**

- The `CHANGELOG.md` is updated with a detailed entry for this fix, including SpecStory references.

**✅ Tests (Functional)**

- All relevant tests for the new behavior are present and functionally pass (i.e., the logic is correct and verified).

**❌ Linter/Type Errors (Blocking)**

- There are TypeScript linter errors in `startSession.test.ts`:
  - Mocking `TaskService` fails due to private/protected members and method signature mismatches.
  - Some method calls on the mock backend are missing required arguments.
  - Type errors regarding the assignment of `null` or `undefined` to non-nullable types.

### Next Steps (Required)

**You must resolve all TypeScript linter/type errors in `/src/commands/session/startSession.test.ts` before this task can be considered complete.**

1. **Explicitly acknowledge and review all current linter/type errors.**

   - See the error list in the task history for details.

2. **Refactor the test mocks to fully satisfy the `TaskService` and `TaskBackend` interfaces.**

   - Consider using a factory function or a helper to create compliant mocks.
   - Ensure all required methods and properties (including private/protected) are handled or worked around.
   - If the interface cannot be mocked directly due to private members, consider extracting a public interface for testing purposes.

3. **Fix all method signature mismatches.**

   - Ensure all required arguments are provided in mock method calls.

4. **Ensure all types are correctly assigned.**

   - Avoid assigning `null` or `undefined` to non-nullable types unless the type allows it.

5. **Run the linter and TypeScript compiler.**

   - Confirm that there are **zero errors or warnings**.

6. **Document your changes in the task work log and update the changelog if needed.**

**Important**: According to the `dont-ignore-errors` rule, this task cannot be considered complete until all errors (including linter/type errors) are resolved. Do not mark this task as complete until the codebase is clean.
