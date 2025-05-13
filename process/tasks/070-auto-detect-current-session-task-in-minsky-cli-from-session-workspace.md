# Task #070: Auto-Detect Current Session/Task in Minsky CLI from Session Workspace

## Context

Currently, some Minsky CLI commands require explicitly specifying a session or task ID even when the command is run from within an active session workspace. For example, `minsky tasks list` does not seem to filter or highlight the current task when run inside its session directory. Other commands like `minsky session update` or `minsky session commit` have auto-detection, but this isn't universal.

The `minsky session dir` command has a note: "If no session or task is provided, auto-detects the current session if run from a session workspace." This capability should be consistently available and utilized by other relevant commands.

## Goal

Enhance Minsky CLI commands to automatically detect the current session and/or associated task when executed from within a session workspace, simplifying workflows and reducing the need for explicit ID arguments.

## Requirements

1.  **Identify Target Commands:** Review Minsky CLI commands that operate on sessions or tasks and could benefit from auto-detection. Examples:
    - `minsky tasks get [id]` -> `minsky tasks get` (should get current task if in session)
    - `minsky tasks list` -> Should ideally highlight or prioritize the current task.
    - `minsky session get [session]` -> `minsky session get` (should get current session)
    - Any other command where context can be inferred.
2.  **Detection Mechanism:**
    - Leverage the existing mechanism (if any, as hinted by `minsky session dir`) or develop a robust way to identify the current session/task from the environment (e.g., current working directory path matching session workspace patterns like `.../sessions/task#XXX`).
    - Consider environment variables if Minsky sets any upon entering a session context (though path-based detection is likely more reliable).
3.  **Behavior without Explicit ID:**
    - If a command is run within a session workspace and no explicit session/task ID is provided, it should operate on the current session/task.
    - If run outside a session workspace and no ID is provided, the command should behave as it currently does (e.g., list all, or error if ID is mandatory).
4.  **Override Capability:** Users should still be able to provide an explicit session/task ID to override the auto-detection if they need to operate on a different session/task from within a session workspace.
5.  **Clear Feedback:**
    - When auto-detection is used, commands could provide a subtle indication (e.g., "Operating on current session: task#064", "Auto-detected task ID: ...").
    - If auto-detection fails (e.g., run outside a workspace and ID is needed), the error message should be clear.
6.  **Consistency:** The auto-detection logic should be centralized (e.g., in a utility function or as part of the session/task resolution in the domain layer) and applied consistently.
7.  **Testing:**
    - Add unit tests for the detection logic.
    - Add integration tests for key commands to verify they correctly auto-detect and operate on the inferred session/task. Test cases should include running commands inside and outside session workspaces, with and without explicit IDs.

## Implementation Steps

- [x] Investigate the current auto-detection mechanism used by `minsky session dir`.
- [x] Develop or refine a utility function `getCurrentSessionContext(): { sessionId: string, taskId?: string } | null` that determines the session/task from CWD. (Added to `src/domain/workspace.ts`)
- [x] Refactor relevant CLI commands (e.g., in `src/commands/tasks/*`, `src/commands/session/*`) to use this utility when an explicit ID is not provided. (Done for `tasks get`, `tasks list`; `session get` already had suitable auto-detection).
- [x] Update command argument/option parsing to make IDs optional where appropriate if auto-detection can be a fallback. (Done for `tasks get`).
- [x] Add comprehensive unit and integration tests. (Unit tests for `getCurrentSessionContext` added; CLI integration tests for `tasks get` auto-detection added/updated. Addressed several pre-existing test issues in other files to stabilize test runs).
- [x] Update CLI help messages where behavior changes (e.g., if an ID argument becomes optional). (Done for `tasks get`).
- [ ] Address remaining integration test failures in `src/adapters/__tests__/integration/` (Covered by new Task #073).
- [ ] Consider refactoring other commands (e.g., `tasks status set`, `git pr`) to use `getCurrentSessionContext` where applicable.

## Work Log

- Investigated `minsky session dir` and `src/domain/workspace.ts` to understand existing auto-detection.
- Designed and implemented `getCurrentSessionContext` in `src/domain/workspace.ts` to return both session and associated task ID.
- Refactored `getCurrentSessionContext` to accept `getCurrentSessionFn` as a dependency for better testability.
- Added unit tests for `getCurrentSessionContext` in `src/domain/workspace.test.ts`, including fixes for mock DI.
- Modified `src/commands/tasks/get.ts` to make `task-id` optional and use `getCurrentSessionContext` for auto-detection. Added CLI feedback for auto-detection.
- Updated `src/commands/tasks/list.ts` to use `getCurrentSessionContext` to highlight the current task.
- Updated CLI integration tests in `src/commands/tasks/get.test.ts` for auto-detection scenarios.
- Debugged and fixed multiple issues in other test files (`domain/__tests__/session.test.ts`, `domain/__tests__/tasks.test.ts`, `commands/git/commit.test.ts`) related to mock syntax, type errors, and test logic to ensure a stable testing environment for the primary changes.
- Addressed process errors by ensuring work was performed in the session workspace and dependencies were installed there.
- Created follow-up task #073 for remaining adapter integration test failures.

## Verification

- [x] Running `minsky tasks get` from within a session workspace linked to a task (e.g., `task#003`) correctly retrieves details for that task and prints an "Auto-detected" message.
- [x] Running `minsky tasks list` from a session workspace linked to a task highlights that task (e.g., with a `*` prefix).
- [x] Running these commands with an explicit different task ID (e.g., `minsky tasks get #001`) from within another task's workspace still works for the explicit ID.
- [x] Running commands outside a session workspace without an ID behaves as before (e.g., `tasks get` errors, `tasks list` lists all applicable).
- [x] All new and modified unit tests for `getCurrentSessionContext` and `tasks get` pass.
- [ ] All integration tests in `src/adapters/__tests__/integration/` pass (Covered by Task #073).

## Working

- Centralized session/task auto-detection logic in a new utility (`getCurrentSessionContext`).
- Updated CLI commands (`minsky tasks get`, `minsky tasks list`, etc.) to use this utility, making task ID arguments optional and providing clear feedback.
- Ensured session/task auto-detection is not duplicated but reused across commands.
- Added and updated unit and integration tests for the new auto-detection logic.
- Fixed most test errors related to mocking, type mismatches, and assertion mismatches.
- Updated all imports of `normalizeTaskId` to use the new location from `domain/tasks` instead of `utils/task-utils`.
- Added null checking for `normalizeTaskId` return values in all commands that use it to prevent type errors.
- Created a re-export of `normalizeTaskId` in `src/domain/tasks.ts` to maintain backward compatibility.
- Fixed SessionRecord type issues in `startSession.ts` to handle the branch property correctly.

## Remaining Work

- Fix integration test failures in the adapter tests (`src/adapters/__tests__/integration/tasks.test.ts` and `src/adapters/__tests__/integration/session.test.ts`).
- Update the mocking approach in these tests to use Bun's mocking API correctly.
- Consider refactoring other commands (e.g., `tasks status set`, `git pr`) to use `getCurrentSessionContext` where applicable.
- Run a full test suite to verify all changes work correctly.
