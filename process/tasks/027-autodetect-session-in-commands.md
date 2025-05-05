# Task #027: Auto-detect Session Context in Session Commands

## Context

Currently, when running commands like `minsky session get`, `minsky session dir`, or other session-related commands within a session workspace, users must explicitly provide the session name. This creates unnecessary friction as the session context is already implicitly available from the workspace location. Task #016 implemented workspace detection for task operations, and we need to extend this functionality to session commands with a targeted and immediately actionable approach.

## Requirements

1. **Automatic Session Detection**
   - When any session command is run from within a session workspace:
     - Automatically detect the current session context
     - Use the detected session as the default if no session name is provided
     - Allow explicit session names to override the auto-detected session

2. **Commands to Update**
   - `session dir`: Use current session if no name provided
   - `session get`: Use current session if no name provided
   - `session update`: Use current session if no name provided
   - `session delete`: Require explicit session name for safety (no auto-detection for destructive operations)
   - Any other session-related commands that take a session name

3. **Utility Functions**
   - Create a `getCurrentSession` utility function to extract session context from the current working directory
   - Integrate with the existing workspace detection utilities
   - Make the utility easy to reuse across all session commands

4. **Error Handling**
   - Provide clear error messages when:
     - Not in a session workspace but no session name provided
     - In a session workspace but the session record is not found in the database
   - Include helpful suggestions in error messages

5. **Option Consistency**
   - Maintain consistency with existing command options like `--json` and `--quiet`
   - Add `--ignore-workspace` option to bypass workspace detection when needed

## Implementation Steps

1. [x] Add session context detection utilities:
   - [x] Create `getCurrentSession` function in workspace module
   - [x] Build on existing `getSessionFromRepo` function
   - [x] Add unit tests for new functions

2. [x] Update `session dir` command:
   - [x] Modify to use workspace detection when no session name is provided
   - [x] Add `--ignore-workspace` option
   - [x] Update help text to explain the automatic detection
   - [x] Add tests for auto-detection scenarios

3. [x] Update `session get` command:
   - [x] Modify to use workspace detection when no session name or task ID is provided
   - [x] Add `--ignore-workspace` option
   - [x] Update help text to explain the automatic detection
   - [x] Add tests for auto-detection scenarios

4. [x] Update `session update` command:
   - [x] Modify to use workspace detection when no session name is provided
   - [x] Add `--ignore-workspace` option
   - [x] Update help text to explain the automatic detection
   - [x] Add tests for auto-detection scenarios

5. [x] Review other session commands that take session names:
   - [x] Identify other commands that should use auto-detection (already covered)
   - [x] Apply consistent workspace detection behavior
   - [x] Update help text and tests as needed

6. [x] Add integration tests:
   - [x] Test commands in various working directory contexts
   - [x] Verify correct behavior with and without explicit session names

## Verification

- [x] Running `minsky session dir` from within a session workspace returns the current session's directory path
- [x] Running `minsky session get` from within a session workspace returns details for the current session
- [x] Explicitly providing a session name overrides auto-detection
- [x] Clear error messages are shown when not in a session workspace and no session name is provided
- [x] The `--ignore-workspace` option successfully bypasses auto-detection
- [ ] All tests pass, including unit and integration tests
- [x] Documentation and help text accurately reflect the new behavior

## Implementation Notes

- Build on the existing workspace detection functionality from Task #016
- Ensure backward compatibility for calls outside of session workspaces
- Prioritize a clean, consistent user experience across all session commands

## Work Log
- 2025-05-02: Implemented getCurrentSession utility in workspace module and updated session dir command for auto-detection.
- 2025-05-02: Discovered that session get command already supports auto-detection with --ignore-workspace option.
- 2025-05-02: Updated session update command to use getCurrentSession utility for consistency and added --ignore-workspace option.
- 2025-05-02: Added unit tests for getCurrentSession function in workspace.test.ts.
- 2025-05-02: Reviewed all session commands and determined that session delete should not use auto-detection for safety reasons.
- 2025-05-04: Fixed linter errors in session and workspace files.
- 2025-05-04: Updated tests to verify auto-detection functionality for all commands.
- 2025-05-04: Added support for both legacy and new path formats for backward compatibility.
- 2025-05-04: Updated error messages to be more helpful and consistent across commands.
