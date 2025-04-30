# Task #017: Support Both Task ID Formats in `--task` Option

## Context

Currently, when using the `--task` option in Minsky commands, task IDs need to be normalized to a standard format with a leading hash symbol (e.g., `#001`). In the `session start` command, there is already code that normalizes task IDs without the leading hash, but this behavior should be consistent across all commands that accept a task ID. This will improve user experience by allowing more flexible input formats.

## Requirements

1. **Consistent Task ID Normalization**
   - Update all commands that accept a `--task` option to support both formats:
     - With leading hash: `#001`
     - Without leading hash: `001`
   - Normalize task IDs in a consistent way across the codebase
   - Consider creating a shared utility function for task ID normalization

2. **Commands to Update**
   - `session start`: Already partially implements this behavior
   - `session get`: Currently requires exact task ID format
   - Any other commands that accept task IDs as parameters or options

3. **Domain Logic**
   - Normalization should happen at the command level, not in the domain layer
   - Tasks should continue to be stored and managed with the standard format (with leading hash)

4. **Error Handling**
   - Ensure clear error messages are provided if a task ID is invalid
   - Maintain existing validation logic for task existence

## Implementation Steps

1. [x] Identify all commands that accept task IDs as parameters or options
   - [x] Review `session` commands
   - [x] Review `tasks` commands
   - [x] Check for other command groups that may use task IDs

2. [x] Create a shared utility function for task ID normalization
   - [x] Add function to appropriate utility module
   - [x] Implement consistent normalization logic
   - [x] Add appropriate tests for the utility function

3. [x] Update commands to use the normalization utility
   - [x] Modify `session start` command to use the shared utility instead of inline normalization
   - [x] Update `session get` command to normalize task IDs
   - [x] Update any other commands that accept task IDs

4. [x] Add or update tests to verify the normalization behavior
   - [x] Test with task IDs in both formats
   - [x] Verify error cases

5. [x] Update documentation to reflect the supported formats
   - [x] Update command help text where appropriate
   - [x] Update relevant sections in README or other documentation

## Verification

- [x] Running commands with task IDs without the leading hash works correctly
  - [x] `minsky session start --task 001` should work the same as `minsky session start --task #001`
  - [x] `minsky session get --task 001` should work the same as `minsky session get --task #001`
  - [x] Any other commands accepting task IDs should handle both formats

- [x] The normalized task ID (with leading hash) is used in all operations
  - [x] Task ID is stored correctly in the session database
  - [x] Error messages show the normalized task ID

- [x] Error handling works correctly
  - [x] Invalid task IDs are caught and reported
  - [x] Appropriate error messages are shown

- [x] All tests pass

## Work Log

- 2023-12-31: Created a new utility function `normalizeTaskId` in `src/utils/task-utils.ts` with tests
- 2023-12-31: Updated `session get` command to use the normalization utility for `--task` option
- 2023-12-31: Updated `session start` command to use the utility instead of inline normalization
- 2023-12-31: Updated `tasks get` and `tasks status` commands to normalize task IDs
- 2023-12-31: Added PR description with summary of changes 
