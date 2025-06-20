# Fix Session Update Command Implementation

## Context

The `minsky session update` command is not working properly. After investigating the codebase, several issues have been identified:

1. The domain function `updateSessionFromParams()` returns void, but the CLI adapter expects a return value with session information
2. There's parameter name inconsistency (some interfaces use `name`, others use `session`)
3. The CLI's `--force` option isn't correctly passed through to the domain function
4. The output handling in the CLI needs improvement to consistently report success or failure

## Requirements

1. **Fix Parameter Naming Inconsistency**

   - Update interfaces to use consistent parameter naming across all adapters
   - Ensure parameters are properly transformed at adapter boundaries

2. **Improve Domain Function Return Value**

   - Modify `updateSessionFromParams()` to return session information after updates
   - Return the session record with updated information for consumption by CLI/MCP

3. **Handle Force Option Correctly**

   - Ensure the `--force` option is properly passed to the domain function
   - Implement proper handling of force updates in the domain logic

4. **Improve Error Handling and Output**
   - Enhance error messages with more specific information
   - Ensure consistent output format between success and error cases

## Implementation Steps

1. [ ] Update parameter schema in `src/schemas/session.ts`

   - [ ] Ensure consistent naming across interfaces
   - [ ] Add force option to session update params schema

2. [ ] Modify domain function in `src/domain/session.ts`

   - [ ] Update `updateSessionFromParams()` to return session information
   - [ ] Handle force option in the update logic
   - [ ] Improve error handling with more detailed messages

3. [ ] Update CLI adapter in `src/adapters/cli/session.ts`

   - [ ] Fix parameter mapping in `createUpdateCommand()`
   - [ ] Properly handle returned session information
   - [ ] Improve output formatting for both success and error cases

4. [ ] Update MCP adapter in `src/adapters/mcp/session.ts`

   - [ ] Align parameters with domain function expectations
   - [ ] Ensure consistent response format

5. [ ] Update shared command implementation in `src/adapters/shared/commands/session.ts`

   - [ ] Pass parameters correctly to domain function
   - [ ] Format response consistently

6. [ ] Add tests to verify fixes
   - [ ] Test for force option handling
   - [ ] Test for error cases
   - [ ] Test for successful update with return value

## Verification

- [ ] Running `minsky session update <session-name>` successfully updates a session
- [ ] The command reports success with session details
- [ ] Using `--force` properly updates a dirty workspace
- [ ] Error messages are clear and specific
- [ ] Tests for the fixed functionality pass
