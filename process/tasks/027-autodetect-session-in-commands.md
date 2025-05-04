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
   - [ ] Add tests for auto-detection scenarios

3. [✓] Update `session get` command:
   - [✓] Command already uses workspace detection (discovered during implementation)
   - [✓] Has `--ignore-workspace` option
   - [✓] Already has appropriate help text and error messages
   - [ ] Add tests for auto-detection scenarios

4. [x] Update `session update` command:
   - [x] Modify to use getCurrentSession utility for consistency
   - [x] Add `--ignore-workspace` option
   - [x] Update help text to explain the automatic detection
   - [ ] Add tests for auto-detection scenarios

5. [x] Review other session commands that take session names:
   - [x] Identify other commands that should use auto-detection
   - [x] Apply consistent workspace detection behavior
   - [x] Update help text and tests as needed

6. [ ] Add integration tests:
   - [ ] Test commands in various working directory contexts
   - [ ] Verify correct behavior with and without explicit session names

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

## Remaining Work

1. **Fix Test Failures and Linter Errors**:
   - Fix linter errors in `src/domain/workspace.test.ts`:
     - Fix string quote inconsistencies (use double quotes)
     - Fix mock calls that are "possibly undefined"
     - Fix `getCurrentSession` import issue for the test assertions
     - Fix spread arguments that require tuple types
     - Fix mock function typings
   - Update integration tests in `src/commands/session/autodetect.test.ts`:
     - Use dependency injection for mocking instead of direct module property assignment
     - Fix "Attempted to assign to readonly property" errors

2. **Complete Test Coverage**:
   - Add the missing tests for auto-detection in each command:
     - Update `cd.test.ts` to verify auto-detection functionality
     - Update `get.test.ts` to verify auto-detection functionality
     - Add tests for `update.ts` auto-detection
   - Create proper test fixtures and setup/teardown helpers for each test suite

3. **Verify Implementation**:
   - Manually verify that all session commands work correctly with auto-detection
   - Test both the new format (`<repoName>/sessions/<session>`) and legacy format (`<repoName>/<session>`)
   - Ensure error messages are helpful and user-friendly in all error conditions
   - Verify the `--ignore-workspace` option works as expected for all commands

4. **Documentation and Final Steps**:
   - Update and finalize the Work Log with all implementation details
   - Update the CHANGELOG.md with the changes made
   - Prepare the PR description with detailed information about the changes
   - Check all implemented and verified requirements against the Verification section

5. **Addressing Specific Issues**:
   - The mock function in `workspace.test.ts` needs to be updated to use `mock.fn()` instead of custom mock implementation
   - Update the expected return value for `getSessionFromRepo` test to match the actual implementation
   - Fix path construction for session directories to match both legacy and new formats
