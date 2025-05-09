# Task #044: Fix Test Failures in Minsky

## Description

Several tests in the Minsky codebase are failing. This task is to fix these failures one by one to ensure the test suite passes completely.

## Context

When running `bun test`, numerous test failures occur across different test files. These tests need to be fixed to ensure the test suite is reliable. The failures appear to be related to mocking approaches, session database setup, and workspace path configurations.

## Requirements

1. Fix the failing tests in the following files:

   - `src/commands/tasks/status.test.ts`: Fix Jest reference errors (✓ In progress)
   - `src/commands/tasks/list.test.ts`: Fix invalid workspace path errors
   - `src/commands/session/cd.test.ts`: Fix session not found errors
   - `src/commands/session/delete.test.ts`: Fix session not found errors
   - `src/commands/session/dir.test.ts`: Fix session not found errors
   - `src/commands/session/get.test.ts`: Fix unexpected syntax error (✓ Fixed)
   - `src/commands/session/list.test.ts`: Fix session not found errors
   - `src/commands/session/startSession.test.ts`: Fix mocking issues
   - `src/commands/session/__tests__/autoStatusUpdate.test.ts`: Fix mock.resetAll issues (✓ Fixed)
   - `src/domain/__tests__/gitServiceTaskStatusUpdate.test.ts`: Fix assignment to import errors (✓ Fixed)

2. All tests should pass when running `bun test`

## Acceptance Criteria

- [ ] All test errors are fixed
- [ ] Running `bun test` results in all tests passing
- [ ] No new failures or errors are introduced

## Implementation Notes

1. The Jest reference errors suggest we need to replace Jest mocking with Bun's mocking functionality
2. Test workspace path issues might require changes to test directory creation/setup
3. Session not found errors indicate problems with session database mocking or setup
4. Some mocking issues might require changes to how mocks are managed between tests

## Work Log

### Progress (2024-09-10)

- Fixed merge conflict in `src/commands/session/get.test.ts`
- Updated `src/domain/__tests__/gitServiceTaskStatusUpdate.test.ts` to avoid modifying imports directly
- Fixed `src/commands/session/__tests__/autoStatusUpdate.test.ts` by replacing `mock.resetAll()` with individual mock clearing
- Started fixing Jest references in `src/commands/tasks/status.test.ts` but still need to complete the update

### Next Steps

1. Complete the fix for Jest references in status.test.ts
2. Fix the test workspace path issues in list.test.ts
3. Fix the session database setup in the session command tests
4. Fix the mocking issues in startSession.test.ts

## Out of Scope

- Refactoring test structure beyond what's needed to make them pass
- Adding new tests for additional functionality
