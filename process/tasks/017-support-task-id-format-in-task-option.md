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

1. [ ] Identify all commands that accept task IDs as parameters or options
   - [ ] Review `session` commands
   - [ ] Review `tasks` commands
   - [ ] Check for other command groups that may use task IDs

2. [ ] Create a shared utility function for task ID normalization
   - [ ] Add function to appropriate utility module
   - [ ] Implement consistent normalization logic
   - [ ] Add appropriate tests for the utility function

3. [ ] Update commands to use the normalization utility
   - [ ] Modify `session start` command to use the shared utility instead of inline normalization
   - [ ] Update `session get` command to normalize task IDs
   - [ ] Update any other commands that accept task IDs

4. [ ] Add or update tests to verify the normalization behavior
   - [ ] Test with task IDs in both formats
   - [ ] Verify error cases

5. [ ] Update documentation to reflect the supported formats
   - [ ] Update command help text where appropriate
   - [ ] Update relevant sections in README or other documentation

## Verification

- [ ] Running commands with task IDs without the leading hash works correctly
  - [ ] `minsky session start --task 001` should work the same as `minsky session start --task #001`
  - [ ] `minsky session get --task 001` should work the same as `minsky session get --task #001`
  - [ ] Any other commands accepting task IDs should handle both formats

- [ ] The normalized task ID (with leading hash) is used in all operations
  - [ ] Task ID is stored correctly in the session database
  - [ ] Error messages show the normalized task ID

- [ ] Error handling works correctly
  - [ ] Invalid task IDs are caught and reported
  - [ ] Appropriate error messages are shown

- [ ] All tests pass 
