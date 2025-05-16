# Task: Revisit GitService Testing Strategy

## Context

The current tests for GitService in src/domain/git.test.ts are inadequate, testing only API structure rather than behavior. They rely on low-level mocking of execAsync, which creates fragile tests.

## Requirements

1. Refactor GitService to properly support dependency injection or use higher-level abstractions for testing
2. Replace low-level mocks with proper service-level mocking
3. Test actual behavior rather than just API shape
4. Align with the testing patterns used in other parts of the codebase

## Implementation Steps

1. [ ] Review existing GitService implementation and identify dependency injection points
2. [ ] Refactor GitService to accept mock dependencies
3. [ ] Update tests to use proper service-level mocks
4. [ ] Ensure tests verify actual behavior rather than just API shape

## Verification

- [ ] Tests don't rely on low-level execAsync mocking
- [ ] Tests verify actual behavior of GitService methods
- [ ] No more fragile tests that break when implementation details change
