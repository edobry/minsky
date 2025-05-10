# Task #044: Fix Remaining Test Failures in Minsky

## Summary
Task #044 made significant progress in fixing test failures, but there are still 10 test failures primarily related to session command tests. This task aims to resolve the remaining test failures to ensure the test suite passes completely.

## Context
This task is a continuation of task #044, which made significant progress in fixing test failures in the Minsky codebase. After implementation of virtual filesystem operations and mock command runners in task #044, most tests are now passing, but there are still 10 test failures mostly related to session command tests. These remaining test failures need to be addressed to ensure the test suite is reliable for future development.

## Background/Motivation
A reliable test suite is crucial for maintaining code quality and preventing regressions. While the previous task (#044) fixed many test failures by implementing virtual filesystem operations and mock command runners, several session-related tests are still failing. These failures need to be addressed to complete the test suite stabilization.

## Goals
- Fix the 10 remaining test failures in session command tests
- Ensure all tests are properly mocked and don't rely on actual filesystem operations
- Standardize the approach to mocking across all test files
- Improve test stability and predictability

## Non-Goals
- Rewriting the entire test suite
- Adding new features or functionality

## Detailed Design

### Remaining Failed Tests
The following tests are still failing:
1. `session/cd.test.ts` - Session command output expectations
2. `session/get.test.ts` - Task ID lookup expectations
3. `session/delete.test.ts` - JSON output handling
4. `session/dir.test.ts` - Task ID/path resolution, error message expectations

### Implementation Plan
1. **Standardize Session Test Mock Approach**:
   - Create a consistent mock system for session command tests
   - Implement a standardized `runCliCommand` mock function
   - Ensure all test files use the same approach to session database mocking

2. **Fix Session Directory Path Resolution**:
   - Update `session/dir.test.ts` to correctly handle both session names and task IDs
   - Fix path expectations to match actual implementation behavior
   - Fix error message expectations

3. **Fix Task ID Lookup Expectations**:
   - Update `session/get.test.ts` to align test expectations with actual output
   - Fix mocking for the `--task` flag option

4. **Fix Error Handling in Session Commands**:
   - Standardize error message expectations across all session command tests
   - Ensure consistent handling of various error conditions

## Testing
- All fixed tests should pass with `bun test`
- Test coverage should be maintained or improved
- No new test failures should be introduced

## Implementation Tasks
1. Standardize the mock approach in all session command test files
2. Fix task ID lookup expectations in `session/get.test.ts`
3. Fix session path resolution in `session/dir.test.ts` 
4. Fix error message expectations in all session command tests
5. Update DELETE command JSON output handling
6. Verify all tests pass with `bun test`

## Resources/References
- Previous task: #044 Fix Test Failures in Minsky
- Session command implementation files in `src/commands/session/`
- Test mocking utilities in `src/utils/test-helpers.ts` 
