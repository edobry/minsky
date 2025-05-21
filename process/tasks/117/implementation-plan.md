# Implementation Plan for Task #117: Fix Session Update Command

## Issues Identified

After analyzing the codebase, I've confirmed the following issues with the `minsky session update` command:

1. **Return Value Inconsistency:**
   - The domain function `updateSessionFromParams()` returns `void` but CLI and shared adapters expect a session object
   - This causes the CLI to incorrectly reference undefined values

2. **Parameter Naming Inconsistency:**
   - Some interfaces use `name` while others use `session` for the session identifier
   - This creates confusion in the parameter mapping between adapters

3. **Force Option Not Implemented:**
   - The `--force` option is defined in the CLI but not properly passed through to the domain function
   - The domain function doesn't handle the force option for updating dirty workspaces

4. **Output Handling Issues:**
   - Error messages lack specificity
   - Success output is inconsistent due to the return value issue

## Implementation Strategy

### 1. Update Session Schema

- Add `force` parameter to `SessionUpdateParams` interface in `src/schemas/session.ts`
- Ensure consistent parameter naming across all interfaces

### 2. Modify Domain Function

- Update `updateSessionFromParams()` in `src/domain/session.ts` to return the session information
- Implement proper handling of the `force` parameter
- Enhance error messages to be more specific

### 3. Update CLI Adapter

- Modify `createUpdateCommand()` in `src/adapters/cli/session.ts` to correctly handle the returned session info
- Ensure proper parameter mapping from CLI to domain function
- Improve output formatting for success and error cases

### 4. Update Shared Command Implementation

- Update the session update command implementation in `src/adapters/shared/commands/session.ts`
- Ensure consistent parameter naming and proper error handling

### 5. Update MCP Adapter

- Update the session update command in `src/adapters/mcp/session.ts`
- Ensure it aligns with the changes in the domain function

### 6. Add Tests

- Update existing tests to verify the fixes
- Add new tests specifically for testing the force option

## Implementation Steps in Detail

1. **Update Session Schema**:
   - Modify `sessionUpdateParamsSchema` in `src/schemas/session.ts` to include the force option
   - Update `SessionUpdateParams` type to reflect the changes

2. **Modify Domain Function**:
   - Update `updateSessionFromParams()` in `src/domain/session.ts` to return a `Session` object
   - Implement force option logic to handle dirty workspaces
   - Improve error handling with more specific error messages

3. **Update CLI Adapter**:
   - Fix `createUpdateCommand()` in `src/adapters/cli/session.ts` to use the returned session info
   - Ensure proper error handling
   - Improve the output format for better user experience

4. **Update Shared Command Implementation**:
   - Update the update command in `src/adapters/shared/commands/session.ts`
   - Ensure it properly handles the returned session information

5. **Update MCP Adapter**:
   - Update the update command in `src/adapters/mcp/session.ts`
   - Ensure it correctly uses the returned session information

6. **Testing**:
   - Update tests to verify that the force option works as expected
   - Add tests for error cases to ensure proper error handling
   - Verify that the returned session information is correctly used

## Verification Strategy

1. Test the command with a clean workspace
2. Test the command with a dirty workspace without the force option (should fail)
3. Test the command with a dirty workspace with the force option (should succeed)
4. Verify that the output is consistent and informative
5. Run automated tests to ensure all functionality works as expected 
