# Migration Criteria for Test Files

This document outlines the criteria for successful migration of tests from Jest/Vitest patterns to native Bun patterns.

## Success Criteria

A test file is considered successfully migrated when:

1. **Functional Equivalence**
   - The test passes with Bun's test runner
   - All test cases from the original file are preserved
   - The test coverage remains the same or improves
   - All assertions verify the same conditions as the original

2. **Pattern Adherence**
   - Uses native Bun mocking features instead of Jest/Vitest patterns
   - Uses `mock()` instead of `jest.fn()`
   - Uses `mock.module()` instead of `jest.mock()`
   - Uses Bun's assertion patterns

3. **Code Quality**
   - No duplicated test code
   - Improved readability over the original
   - Follows project-wide testing conventions
   - Leverages dependency injection where appropriate
   - Uses centralized test utilities

4. **Performance**
   - Equal or better execution time than the original
   - Reduced setup/teardown complexity where possible

## Verification Steps

For each migrated test, perform the following verification steps:

1. **Run the test**: `bun test <path-to-test-file> --bail`
2. **Check coverage**: `bun test <path-to-test-file> --coverage`
3. **Compare coverage** with original test
4. **Review mocking patterns** to ensure they use Bun native features
5. **Verify assertions** match the original test's intent

## Migration Patterns

Common migration patterns are documented in the Migration Patterns Library:

| Jest/Vitest Pattern | Bun Equivalent |
|---------------------|----------------|
| `jest.fn()` | `mock()` |
| `jest.fn().mockReturnValue(x)` | `mock(args => x)` or use extended mock utilities |
| `jest.mock('module')` | `mock.module('module', () => { /* implementation */ })` |
| `jest.spyOn(object, 'method')` | Use dependency injection or mock utilities |
| `expect(x).toEqual(y)` | `expect(x).toEqual(y)` (compatible) |

## Error Handling

Common migration errors and their solutions:

1. **Missing mock properties**
   - Use the Bun compatibility layer in `src/utils/test-utils/mock-compatibility.ts`
   - Implement custom mock utilities for specific patterns

2. **Module mocking differences**
   - Use explicit mock module implementations instead of auto-mocking
   - Consider using dependency injection instead of module mocking

3. **Lifecycle hook differences**
   - Ensure `beforeEach`/`afterEach` are imported from `bun:test`
   - Use the `cleanupMocks()` utility from test utils

## Documentation Requirements

Each migrated test should include:

1. A JSDoc comment explaining the migration approach
2. Reference to any utilities or patterns used
3. Notes on any special considerations or challenges
4. Reference to the original test (if substantially changed) 
