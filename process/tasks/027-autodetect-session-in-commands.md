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

4. [ ] Update `session update` command (if it exists):
   - [ ] Modify to use workspace detection when no session name is provided
   - [ ] Add `--ignore-workspace` option
   - [ ] Update help text to explain the automatic detection
   - [ ] Add tests for auto-detection scenarios

5. [ ] Review other session commands that take session names:
   - [ ] Identify other commands that should use auto-detection
   - [ ] Apply consistent workspace detection behavior
   - [ ] Update help text and tests as needed

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

### 2025-05-01
- Created initial implementation of auto-detection functionality
- Added `getCurrentSession` utility function to workspace module
- Updated `session dir` and `session get` commands to use the auto-detection
- Added `--ignore-workspace` flag to bypass auto-detection when needed

### 2025-05-02
- Created test script to manually verify auto-detection functionality
- Added dedicated integration tests in `src/commands/session/autodetect.test.ts`
- Enhanced the workspace module to better handle deeply nested session directories
- Updated tests for the modified commands

### 2025-05-07
- Merged origin/main into task#027 branch to resolve conflicts
- Fixed merge conflicts in:
  - CHANGELOG.md
  - process/tasks.md
  - src/commands/session/cd.test.ts
  - src/commands/session/get.ts
  - src/domain/workspace.ts
  - src/domain/workspace.test.ts
- Began fixing test failures after the merge

### 2025-05-08
- Fixed test failures in `src/commands/session/autodetect.test.ts`
  - Corrected JavaScript syntax errors in test scripts
  - Fixed indentation and string quotes
  - Updated module import paths to use correct relative paths
- Fixed test failures in `src/commands/session/get.test.ts`
  - Updated task ID normalization in tests to match implementation
  - Fixed expected error message to match actual output
  - Removed TEST_DIR references and replaced with '/tmp'
- Verified that there's no existing `session update` command to modify

### 2025-05-09
- Started fixing linting errors in test files:
  - Fixed string quote inconsistencies in workspace.test.ts
  - Fixed expected error message in get.test.ts to match actual implementation
- Identified main test issues to fix:
  1. Module property modification errors in autodetect.test.ts:
     - "Attempted to assign to readonly property" when trying to mock getCurrentSession
     - Need to modify test approach to avoid direct module property assignment
  2. Mock function syntax (mock.fn vs mock) in workspace.test.ts
  3. String quote inconsistencies throughout test files
- Not marking the task as DONE until all errors are fixed, per the dont-ignore-errors rule

## Remaining Work

1. **Fix Remaining Test Failures**:
   - ✅ Fixed test script syntax errors in autodetect.test.ts
   - ✅ Fixed task ID lookup tests in get.test.ts
   - Need to fix bun:test mocking approach in autodetect.test.ts to avoid "Attempted to assign to readonly property" errors
   - Need to update mock function usage in workspace.test.ts
   - Need to fix string quote inconsistencies in test files

2. **Implement Better Testing Approach**:
   - For autodetect.test.ts, move from direct module property modification to dependency injection or a test module pattern
   - Consider creating a test helper module for mock management

3. **Documentation and Code Clean-up**:
   - Review code for any unnecessary commented-out sections
   - Ensure consistent code style across all modified files
   - Update inline documentation as needed

4. **Final Verification**:
   - Run a final manual test using the test script to verify functionality
   - Ensure all tests pass before merging to main

5. **Session Update Command**:
   - ✅ Verified that there's no existing `session update` command to modify
   - Note in PR that if a `session update` command is added in the future, it should include the same auto-detection pattern

6. **Address PR Feedback**:
   - Once the PR is submitted, address any feedback from reviewers
