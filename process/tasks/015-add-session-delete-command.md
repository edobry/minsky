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

1. [ ] Add deleteSession method to SessionService:
   - [ ] Add method to delete session repository
   - [ ] Add method to remove session from database
   - [ ] Implement proper error handling
   - [ ] Add rollback mechanism for partial failures

2. [ ] Create new file in src/commands/session/delete.ts:
   - [ ] Define command using Commander.js
   - [ ] Add appropriate options and arguments
   - [ ] Implement action handler to call domain method
   - [ ] Add proper error handling and user feedback

3. [ ] Register command in src/commands/session/index.ts

4. [ ] Add tests:
   - [ ] Unit tests for SessionService.deleteSession
   - [ ] Integration tests for the command
   - [ ] Test cases for:
     - [ ] Successful deletion
     - [ ] Non-existent session
     - [ ] File system errors
     - [ ] Database errors
     - [ ] Force flag behavior
     - [ ] JSON output format

5. [ ] Update documentation:
   - [ ] Add command to README
   - [ ] Update CHANGELOG
   - [ ] Update help text

## Verification

- [ ] Running `minsky session delete <session-name>` successfully:
  - [ ] Removes the session repository directory
  - [ ] Removes the session from the database
  - [ ] Shows appropriate success message
- [ ] Command properly handles non-existent sessions
- [ ] Command properly handles file system errors
- [ ] Command properly handles database errors
- [ ] --force flag works as expected
- [ ] --json flag produces valid JSON output
- [ ] All tests pass
- [ ] Documentation is complete and accurate 
