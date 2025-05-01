# Task #022: Fix Session Test Failures and Linting Issues

## Context

After implementing task #002 for per-repo session storage, several tests are still failing. These failures are primarily due to linting issues, type errors, and mock implementation problems. These need to be fixed to maintain code quality and ensure the test suite accurately validates the codebase functionality.

## Requirements

1. **Linting Fixes**
   - Fix all string quote errors in the test files by replacing single quotes with double quotes
   - Ensure all test files adhere to the project's ESLint configuration

2. **Type Error Corrections**
   - Update the SessionRecord interface in tests to match the production implementation
   - Fix type incompatibilities in test mocks and assertions
   - Ensure the repoPath property is properly defined in the migrateSessionsToSubdirectory test

3. **Mock Implementation Improvements**
   - Properly type all mock objects to match their real counterparts
   - Fix parameter handling in mockExecAsyncImpl to correctly handle expected parameters
   - Implement required interfaces like promiseWithChild in mocks
   - Ensure mocks properly simulate the production environment

## Implementation Steps

1. [ ] Fix string quote linting errors
   - [ ] Update src/domain/workspace.test.ts
   - [ ] Update src/domain/repo-utils.test.ts
   - [ ] Update src/domain/session.test.ts

2. [ ] Fix type errors in SessionRecord interface
   - [ ] Update type definitions in session.test.ts to match production implementation
   - [ ] Fix type assertions in the migrateSessionsToSubdirectory test
   - [ ] Add proper type annotations to mock implementations

3. [ ] Improve mock implementations
   - [ ] Fix mockExecAsyncImpl to handle all parameter variations
   - [ ] Implement the promiseWithChild interface in relevant mocks
   - [ ] Update mocks to properly simulate the real objects

4. [ ] Run and verify tests
   - [ ] Run all tests with `bun test`
   - [ ] Fix any remaining issues
   - [ ] Ensure 100% test pass rate

5. [ ] Update CHANGELOG.md
   - [ ] Document the fixes made

## Verification

- [ ] All tests pass successfully when running `bun test`
- [ ] No linting errors remain in the test files
- [ ] Type checking passes with no errors
- [ ] No code changes to production files are required; all changes are limited to test files
- [ ] CHANGELOG.md is updated to reflect the fixes 

## Work Log

- 2025-05-01: Fixed session.ts to properly define methods on prototype instead of using class properties with arrow functions
- 2025-05-01: Updated SessionDB class to ensure proper implementation of getSessionByTaskId, getRepoPath, and getNewSessionRepoPath methods
- 2025-05-01: Fixed GitService.clone method to avoid session database errors and properly handle path resolution
- 2025-05-01: Fixed string quotes in test files by replacing single quotes with double quotes
- 2025-05-01: Updated git.test.ts and git.pr.test.ts with proper mock setup for execAsync
- 2025-05-01: Fixed type errors in session.test.ts for SessionRecord interface compatibility

## Remaining Work

1. Fix the test failures in git.test.ts:
   - Clone test is failing because mock execAsync is not being called correctly
   - Branch test is failing with similar mock issues
   - PR test has problems with the mock setup

2. Fix remaining type issues in session.test.ts:
   - migrateSessionsToSubdirectory test has incorrect assertions for repoPath property
   - Some mock implementations still have type compatibility issues

3. Improve the mock implementations:
   - Update mock setup in beforeEach blocks to ensure mock.restoreAll() works properly
   - Fix parameter handling in mockExecAsync to properly handle command parameters

4. Run a full test suite and address any additional failures
   
5. Update CHANGELOG.md with these fixes 
