# Re-implement Disabled Integration Tests

## Context

In a recent PR, we had to temporarily disable several integration tests that were causing build failures. These tests were disabled by replacing them with placeholder tests that always pass. While this fixed the immediate build issues, it has left gaps in our test coverage. We need to properly re-implement these tests using the improved testing approaches being developed in Tasks #101-103.

The original tests were failing due to various issues including:

- Inadequate dependency injection making mocking difficult
- Side effects and state management problems in the domain objects
- Limitations in the current test utilities
- Incompatibilities between Jest-style mocking and Bun's test environment

## Problem Statement

We've temporarily disabled several integration tests that were causing failures due to mocking issues and test framework compatibility problems. While disabling these tests fixed the immediate build failures, we need to properly re-implement them to maintain test coverage and ensure the stability of these components.

The affected test files are:

- `src/adapters/__tests__/integration/workspace.test.ts`
- `src/adapters/__tests__/integration/git.test.ts`
- `src/domain/__tests__/github-backend.test.ts`
- `src/domain/__tests__/github-basic.test.ts`
- `src/adapters/__tests__/cli/session.test.ts`
- `src/adapters/__tests__/cli/tasks.test.ts`

## Acceptance Criteria

1. All disabled tests are properly re-implemented using the improved test utilities from Task #103
2. Tests follow the dependency injection patterns established in Task #101
3. Tests align with the functional patterns outlined in Task #102
4. All tests pass reliably without flakiness
5. Test coverage is maintained or improved compared to the original implementation
6. Each test file includes proper documentation about test patterns used
7. No tests are skipped or use placeholder assertions

## Technical Implementation Details

### Dependencies on Other Tasks

This task depends on:

- Task #101: Improve Domain Module Testability with Proper Dependency Injection
- Task #102: Refactor Domain Objects to Follow Functional Patterns
- Task #103: Enhance Test Utilities for Better Domain Testing

The improvements from these tasks should be completed first, as they provide the foundation needed for proper test implementation.

### Re-implementation Strategy

For each test file:

1. **Review Original Implementation**

   - Analyze the original tests to understand intent and coverage
   - Identify specific mocking or test framework issues that caused failures

2. **Apply New Testing Patterns**

   - Use the enhanced test utilities from Task #103
   - Implement proper dependency injection as outlined in Task #101
   - Follow functional testing patterns from Task #102

3. **Test File Specific Approaches**

   **Workspace Integration Tests**

   - Properly mock the filesystem operations
   - Use the new dependency injection patterns for process.cwd()
   - Apply consistent mocking for session context

   **Git Integration Tests**

   - Implement proper git command mocking
   - Use filesystem abstractions for test isolation
   - Apply deterministic test data generation

   **GitHub Backend Tests**

   - Use standardized mocking for external API calls
   - Apply proper dependency injection for services
   - Isolate tests from environment variables

   **CLI Tests**

   - Use proper command execution simulation
   - Apply consistent mocking for user input
   - Verify command outputs through interfaces rather than direct console output

## Risks and Mitigations

**Risks**:

- Some tests might still be flaky if underlying components aren't properly isolated
- Bun testing framework limitations might persist even with improved utilities

**Mitigations**:

- Establish clear boundaries for what should be tested vs. mocked
- Create specialized test utilities for Bun-specific testing patterns
- Consider separating integration tests into their own test suite that can be run independently

## Related Documentation

- Testing router rule should be updated with any new patterns that emerge
- Test implementation should follow the testing-boundaries rule
- Document any Bun-specific testing patterns discovered during implementation
