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
