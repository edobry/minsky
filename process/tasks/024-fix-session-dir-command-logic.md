# Task #024: Fix `session dir` Command Logic

## Context

The `session dir` command is used to print the working directory path for a session, allowing users to easily navigate to a session's directory using `cd $(minsky session dir <session>)`. Currently, the command may have logical issues or limitations in how it handles different session directory scenarios, which need to be fixed to ensure consistent and reliable behavior.

## Requirements

1. **Review Current Logic Issues**
   - Examine the current implementation of the `session dir` command
   - Identify specific problems with how session directories are determined and returned
   - Document the inconsistencies or edge cases that are not handled correctly

2. **Enhance Command Capabilities**
   - Add the `--task` option to support retrieving session directories by task ID
   - Ensure the command handles non-existent sessions gracefully with informative error messages
   - Provide consistent behavior across different session storage configurations

3. **Implementation Changes**
   - Update the command logic to handle all identified edge cases
   - Ensure consistent directory path resolution using the session database
   - Add proper validation for session names and task IDs
   - Update help documentation to reflect new options and behavior

4. **Integration with Existing Features**
   - Ensure compatibility with task ID normalization (both `000` and `#000` formats)
   - Maintain backward compatibility with existing usage patterns

## Implementation Steps

1. [ ] **Investigation**
   - [ ] Review current implementation of the `session dir` command
   - [ ] Identify specific logical issues and edge cases
   - [ ] Document the current behavior and desired improvements

2. [ ] **Implementation**
   - [ ] Add the `--task` option to the command definition
   - [ ] Implement task ID normalization using the existing utility
   - [ ] Update the session directory resolution logic to fix any identified issues
   - [ ] Add proper error handling for non-existent sessions or tasks
   - [ ] Update the command description and help text

3. [ ] **Testing**
   - [ ] Write tests for the updated command, including edge cases
   - [ ] Test integration with the existing task ID normalization
   - [ ] Verify behavior with both existing sessions and non-existent sessions
   - [ ] Test the command with task IDs in both formats

4. [ ] **Documentation**
   - [ ] Update command usage examples in relevant documentation
   - [ ] Add examples for the new `--task` option in help text

## Verification

- [ ] The `session dir` command correctly identifies and returns the session directory
- [ ] The command handles non-existent sessions with clear error messages
- [ ] The command works correctly with the `--task` option to find sessions by task ID
- [ ] Task IDs are properly normalized (both `000` and `#000` formats work)
- [ ] The command maintains backwards compatibility with existing usage patterns
- [ ] All tests for the updated command pass successfully

## Work Log

- [DATE] - Created task specification 
