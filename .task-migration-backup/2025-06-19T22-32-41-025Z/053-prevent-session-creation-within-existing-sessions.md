# Task #053: Prevent Session Creation Within Existing Sessions

## Context

Currently, Minsky allows users to create new sessions while already inside a session workspace. This is problematic because:

- It creates nested sessions, which can lead to confusion and data integrity issues
- Session workspaces should be isolated environments for specific tasks
- Creating sessions from within sessions violates the session isolation principle

When a user attempts to create a session while already in a session workspace, Minsky should detect this situation and prevent it with a clear error message.

## Requirements

1. **Session Creation Safety Check**

   - Before creating a new session, check if the current directory is already within a session workspace
   - If in a session workspace, abort the operation with a clear error message
   - Provide guidance on how to proceed correctly (return to main workspace)

2. **Error Handling**

   - Display a clear, informative error message explaining the issue
   - Exit with a non-zero status code to indicate failure
   - Suggest the correct workflow (returning to main workspace)

3. **Implementation Details**
   - Use the existing `isSessionRepository` function to detect if the current directory is in a session
   - Add this check to the beginning of the session start command
   - Ensure the check works regardless of how deeply nested the current directory is within a session

## Implementation Steps

1. [ ] Update the `session start` command to check if current directory is within a session workspace
2. [ ] Use the existing `isSessionRepository` function with the current directory
3. [ ] Add clear error message when attempting to create a session from within a session
4. [ ] Add tests for the new validation logic
5. [ ] Update documentation to clarify that sessions must be created from the main workspace

## Verification

- [ ] Running `minsky session start new-session` from within a session workspace fails with a clear error message
- [ ] The error message suggests returning to the main workspace
- [ ] The command still works correctly when run from the main workspace
- [ ] Tests pass for both the error case and the normal case
- [ ] Documentation is updated to reflect this requirement
