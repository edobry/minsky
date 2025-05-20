# Task #101: Improve Domain Module Testability with Proper Dependency Injection

## Context

After fixing test failures in the domain module, we've identified several structural issues that make the code difficult to test. The current architecture relies heavily on direct module imports and concrete implementations, leading to tests that require modifying readonly properties or extensive mocking of unused methods.

## Requirements

1. **Interface-Based Design**

   - Define core interfaces for all domain services
   - Extract only the methods used by other components
   - Provide factory functions for default implementations

2. **Consistent Dependency Injection**

   - Refactor domain functions to accept dependencies as parameters
   - Implement a consistent pattern with sensible defaults
   - Focus on commonly used functions first

3. **Enhanced Test Utilities**

   - Create utilities for generating test dependencies
   - Add functions for partial mock implementation
   - Update existing tests to use new patterns

4. **Pure Function Design**
   - Refactor stateful components to be more pure
   - Extract side effects to the edges of the codebase
   - Improve testability through functional design

## Implementation Steps

1. [ ] Create domain interfaces:

   - [ ] Define `SessionProvider` interface for SessionDB operations
   - [ ] Define `GitServiceInterface` for GitService operations
   - [ ] Define `TaskServiceInterface` for TaskService operations
   - [ ] Define `WorkspaceUtilsInterface` for workspace utilities
   - [ ] Add factory functions for default implementations

2. [ ] Implement dependency injection:

   - [ ] Refactor `resolveRepoPath` to use injected dependencies
   - [ ] Refactor `getCurrentSession` and related functions
   - [ ] Update `approveSessionFromParams` dependency handling
   - [ ] Apply pattern to `startSessionFromParams` and `listSessionsFromParams`

3. [ ] Create enhanced test utilities:

   - [ ] Add `createTestDeps` function for generating test dependencies
   - [ ] Create utilities for partial mock implementation
   - [ ] Add helper for mocking without modifying readonly properties

4. [ ] Update existing tests:
   - [ ] Refactor repo-utils tests to use new pattern
   - [ ] Update workspace tests with better dependency injection
   - [ ] Fix session-approve tests without type casting

## Verification

- [ ] All tests pass without modifying readonly properties
- [ ] No more usage of `as any` type casting in tests
- [ ] Consistent dependency injection pattern across the codebase
- [ ] Improved test readability and maintainability
