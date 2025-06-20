# Task #084: Extend Auto-Detection to Additional Commands

## Context

Task #070 implemented auto-detection for current session and task IDs in some CLI commands (`tasks get`, `tasks list`), introducing a centralized utility `getCurrentSessionContext()` for this purpose. However, several other commands could benefit from having the same auto-detection capabilities to create a more consistent and intuitive user experience across the entire CLI.

This task focuses on extending the auto-detection functionality to additional key commands, following the extension plan developed in Task #070.

## Goal

Implement consistent auto-detection behavior across more Minsky CLI commands, leveraging the centralized `getCurrentSessionContext` utility, to allow operating on the current session/task without explicitly providing IDs when in a session workspace.

## Requirements

1. **Extend Auto-Detection to Priority Commands:**

   - Update the `tasks status set` command to auto-detect the current task
   - Update the `git summary` command to auto-detect the current session
   - Review and update `session update` and `session dir` commands to use the centralized utility

2. **Maintain Consistency:**

   - Use the same `getCurrentSessionContext` utility that was implemented in Task #070
   - Provide similar feedback messages when auto-detection is used
   - Handle error cases consistently across all commands

3. **User Experience:**

   - Make task/session IDs optional in command arguments where auto-detection is applicable
   - Preserve the ability to override auto-detection with explicit IDs
   - Provide clear user feedback about auto-detection

4. **Documentation:**

   - Update help text for all modified commands to indicate auto-detection capability
   - Ensure consistent terminology across all commands

5. **Testing:**
   - Add unit tests for each command's auto-detection functionality
   - Add integration tests for all auto-detection scenarios
   - Verify behavior both inside and outside session workspaces

## Implementation Steps

### 1. `tasks status set` Command

- [x] Update argument parsing to make task-id optional in the "set" subcommand
- [x] Add auto-detection logic using `getCurrentSessionContext` when task ID is not provided
- [x] Add clear feedback message when auto-detection is used
- [x] Update command help text to indicate task ID is optional in a session workspace
- [x] Add unit tests for auto-detected task status setting
- [x] Update CLI integration tests to verify behavior in and outside session workspace

### 2. `git summary` Command

- [x] Modify argument parsing to make --session and --repo optional
- [x] Use `getCurrentSessionContext` to auto-detect session when neither flag is provided
- [x] Add feedback message when auto-detection is used
- [x] Update command help to indicate flags are optional in session workspace
- [x] Add unit tests with mocked `getCurrentSessionContext`
- [x] Add CLI integration tests for auto-detection scenarios

### 3. `session update` and Related Commands

- [x] Review `src/adapters/cli/session.ts` update command implementation and migrate to use `getCurrentSessionContext`
- [x] Review `src/adapters/cli/session.ts` dir command implementation and ensure it's using the centralized utility
- [x] Ensure consistent behavior with other auto-detecting commands
- [x] Standardize feedback messages across all session commands
- [x] Update existing tests to verify consistent behavior
- [x] Add tests specifically for auto-detection scenarios

## Implementation Strategy

1. Follow the established pattern from `tasks get` and `tasks list`
2. Use dependency injection for testability
3. Add clear user feedback for auto-detection
4. Update documentation and help text
5. Add comprehensive tests

## Verification

- [x] `minsky tasks status set` works without task ID when run from session workspace
- [x] `minsky git summary` works without session/repo flags when run from session workspace
- [x] `minsky session update` and `minsky session dir` use the centralized `getCurrentSessionContext`
- [x] All commands provide consistent feedback when auto-detection is used
- [x] All commands handle errors consistently when auto-detection fails
- [x] All commands preserve the ability to override auto-detection with explicit IDs
- [x] All unit and integration tests pass

## Related Tasks

- Task #070: Auto-Detect Current Session/Task in Minsky CLI (parent task)
- Task #073: Fix integration test failures in adapter tests
