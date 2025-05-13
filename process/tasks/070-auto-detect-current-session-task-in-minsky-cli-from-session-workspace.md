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
    - When auto-detection is used, commands could provide a subtle indication (e.g., "Operating on current session: task#064").
    - If auto-detection fails (e.g., run outside a workspace and ID is needed), the error message should be clear.
6.  **Consistency:** The auto-detection logic should be centralized (e.g., in a utility function or as part of the session/task resolution in the domain layer) and applied consistently.
7.  **Testing:**
    - Add unit tests for the detection logic.
    - Add integration tests for key commands to verify they correctly auto-detect and operate on the inferred session/task. Test cases should include running commands inside and outside session workspaces, with and without explicit IDs.

## Implementation Steps

- [ ] Investigate the current auto-detection mechanism used by `minsky session dir`.
- [ ] Develop or refine a utility function `getCurrentSessionContext(): { sessionId: string, taskId?: string } | null` that determines the session/task from CWD.
- [ ] Refactor relevant CLI commands (e.g., in `src/commands/tasks/*`, `src/commands/session/*`) to use this utility when an explicit ID is not provided.
- [ ] Update command argument/option parsing to make IDs optional where appropriate if auto-detection can be a fallback.
- [ ] Add comprehensive unit and integration tests.
- [ ] Update CLI help messages where behavior changes (e.g., if an ID argument becomes optional).

## Verification

- [ ] Running `minsky tasks get` from within `/Users/edobry/.local/state/minsky/git/local/minsky/sessions/task#064` correctly retrieves details for task #064.
- [ ] Running `minsky tasks list` from a session workspace highlights or indicates the current task.
- [ ] Running these commands with an explicit different task ID (e.g., `minsky tasks get #001`) from within `task#064`'s workspace still works for #001.
- [ ] Running commands outside a session workspace without an ID behaves as before (e.g., errors or lists all).
- [ ] All new tests pass.
