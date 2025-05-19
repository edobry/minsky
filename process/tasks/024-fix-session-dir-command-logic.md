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

1. [x] **Investigation**

   - [x] Review current implementation of the `session dir` command
   - [x] Identify specific logical issues and edge cases
   - [x] Document the current behavior and desired improvements

2. [x] **Implementation**

   - [x] Add the `--task` option to the command definition
   - [x] Implement task ID normalization using the existing utility
   - [x] Update the session directory resolution logic to fix any identified issues
   - [x] Add proper error handling for non-existent sessions or tasks
   - [x] Update the command description and help text

3. [x] **Testing**

   - [x] Write tests for the updated command, including edge cases
   - [x] Test integration with the existing task ID normalization
   - [x] Verify behavior with both existing sessions and non-existent sessions
   - [x] Test the command with task IDs in both formats

4. [x] **Documentation**
   - [x] Update command usage examples in relevant documentation
   - [x] Add examples for the new `--task` option in help text

## Verification

- [x] The `session dir` command correctly identifies and returns the session directory
- [x] The command handles non-existent sessions with clear error messages
- [x] The command works correctly with the `--task` option to find sessions by task ID
- [x] Task IDs are properly normalized (both `000` and `#000` formats work)
- [x] The command maintains backwards compatibility with existing usage patterns
- [x] All tests for the updated command pass successfully

## Work Log

- [2025-04-29] - Created task specification
- [2025-04-30] - Fixed the session dir command by removing the local getSessionRepoPath function and using SessionDB.getRepoPath instead, which correctly handles both legacy paths and new paths with the sessions subdirectory
- [2025-04-30] - Added support for --task option to allow finding session directories by associated task ID
- [2025-04-30] - Added proper error handling for non-existent sessions, non-existent tasks, and invalid argument combinations
- [2025-04-30] - Updated tests to thoroughly verify all functionality, including legacy path structure, new sessions subdirectory, task ID support, and error scenarios
