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

1. [ ] Add session context detection utilities:
   - [ ] Create `getCurrentSession` function in workspace module
   - [ ] Build on existing `getSessionFromRepo` function
   - [ ] Add unit tests for new functions

2. [ ] Update `session dir` command:
   - [ ] Modify to use workspace detection when no session name is provided
   - [ ] Add `--ignore-workspace` option
   - [ ] Update help text to explain the automatic detection
   - [ ] Add tests for auto-detection scenarios

3. [ ] Update `session get` command:
   - [ ] Modify to use workspace detection when no session name or task ID is provided
   - [ ] Add `--ignore-workspace` option
   - [ ] Update help text to explain the automatic detection
   - [ ] Add tests for auto-detection scenarios

4. [ ] Update `session update` command (if it exists):
   - [ ] Modify to use workspace detection when no session name is provided
   - [ ] Add `--ignore-workspace` option
   - [ ] Update help text to explain the automatic detection
   - [ ] Add tests for auto-detection scenarios

5. [ ] Review other session commands that take session names:
   - [ ] Identify other commands that should use auto-detection
   - [ ] Apply consistent workspace detection behavior
   - [ ] Update help text and tests as needed

6. [ ] Add integration tests:
   - [ ] Test commands in various working directory contexts
   - [ ] Verify correct behavior with and without explicit session names

## Verification

- [ ] Running `minsky session dir` from within a session workspace returns the current session's directory path
- [ ] Running `minsky session get` from within a session workspace returns details for the current session
- [ ] Explicitly providing a session name overrides auto-detection
- [ ] Clear error messages are shown when not in a session workspace and no session name is provided
- [ ] The `--ignore-workspace` option successfully bypasses auto-detection
- [ ] All tests pass, including unit and integration tests
- [ ] Documentation and help text accurately reflect the new behavior

## Implementation Notes

- Build on the existing workspace detection functionality from Task #016
- Ensure backward compatibility for calls outside of session workspaces
- Prioritize a clean, consistent user experience across all session commands 

## Work Log

- 2024-06-10: Updated minsky-workflow rule to include a "Standard Session Navigation Pattern" section that requires using the `--quiet` option for all session navigation
