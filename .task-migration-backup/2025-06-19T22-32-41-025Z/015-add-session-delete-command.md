# Task #015: Add `session delete` Command

## Context

Currently, there is no way to cleanly remove a session and its associated repository through the Minsky CLI. Users need to manually delete the session repository and update the session database. An automated command would improve workflow efficiency and ensure proper cleanup of session resources.

## Requirements

1. **CLI Behavior**

   - Command signature:
     ```
     minsky session delete <session-name>
     ```
   - The command should:
     - Delete the session's repository directory
     - Remove the session record from the session database
     - Support both successful and error cases with appropriate exit codes
     - Provide clear feedback about the deletion status

2. **Integration with Domain Module**

   - Add a deleteSession method to the SessionService class
   - Implement proper error handling for:
     - Non-existent sessions
     - File system errors during repository deletion
     - Database errors during record removal

3. **CLI Options**

   - Support the following options:
     - `--force`: Skip confirmation prompt
     - `--json`: Output result as JSON

4. **Safety Features**
   - Prompt for confirmation before deletion (unless --force is used)
   - Verify session exists before attempting deletion
   - Ensure clean rollback if deletion partially fails
   - Check for uncommitted changes before deletion

## Implementation Steps

1. [x] Add deleteSession method to SessionService:

   - [x] Add method to delete session from database
   - [x] Implement proper error handling
   - [x] Add rollback mechanism for partial failures

2. [x] Create new file in src/commands/session/delete.ts:

   - [x] Define command using Commander.js
   - [x] Add appropriate options and arguments
   - [x] Implement action handler to call domain method
   - [x] Add proper error handling and user feedback

3. [x] Register command in src/commands/session/index.ts

4. [x] Add tests:

   - [x] Unit tests for SessionDB.deleteSession
   - [x] Integration tests for the command
   - [x] Test cases for:
     - [x] Successful deletion
     - [x] Non-existent session
     - [x] File system errors
     - [x] Database errors
     - [x] Force flag behavior
     - [x] JSON output format

5. [x] Update documentation:
   - [x] Add command to CHANGELOG
   - [x] Update help text

## Verification

- [x] Running `minsky session delete <session-name>` successfully:
  - [x] Removes the session repository directory
  - [x] Removes the session from the database
  - [x] Shows appropriate success message
- [x] Command properly handles non-existent sessions
- [x] Command properly handles file system errors
- [x] Command properly handles database errors
- [x] --force flag works as expected
- [x] --json flag produces valid JSON output
- [x] All tests pass
- [x] Documentation is complete and accurate

## Work Log

- 2024-04-30: Added the deleteSession method to SessionDB with tests to ensure it handles various edge cases
- 2024-04-30: Created the delete command implementation with proper error handling and interactive confirmation
- 2024-04-30: Added comprehensive tests for both the domain module and CLI command
- 2024-04-30: Updated CHANGELOG.md and documentation
