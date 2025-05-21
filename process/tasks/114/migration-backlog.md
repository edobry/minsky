# Test Migration Backlog

This document lists the 20 high-priority tests to be migrated as part of Task #114, with a rationale for their prioritization.

## Priority 1: Core Utilities (Foundation)

These tests are foundational and support other tests, making them critical to migrate first:

1. `src/utils/test-utils/__tests__/enhanced-utils.test.ts`
   - **Rationale**: Tests core test utilities used by many other tests
   - **Difficulty**: Easy, Low mocking complexity

2. `src/utils/test-utils/__tests__/mocking.test.ts`
   - **Rationale**: Tests mocking utilities used across the codebase
   - **Difficulty**: Easy, Medium mocking complexity
   - **Note**: Contains jest.spyOn usage that needs migration

3. `src/utils/filter-messages.test.ts`
   - **Rationale**: Tests frequently used utility with simple patterns
   - **Difficulty**: Easy, Low mocking complexity

## Priority 2: Core Domain Tests (Critical Functionality)

These tests cover critical business logic and domain functionality:

5. `src/domain/__tests__/tasks.test.ts`
   - **Rationale**: Tests core task management functionality
   - **Difficulty**: Medium, Medium mocking complexity

6. `src/domain/git.test.ts`
   - **Rationale**: Tests essential Git operations
   - **Difficulty**: Medium, Low mocking complexity

7. `src/domain/git.pr.test.ts`
   - **Rationale**: Tests pull request functionality
   - **Difficulty**: Medium, Low mocking complexity

8. `src/domain/session/session-db.test.ts`
   - **Rationale**: Tests critical session database operations
   - **Difficulty**: Easy, Low mocking complexity

## Priority 3: Adapter Command Tests (User Interface)

These tests cover the command interfaces that users interact with:

9. `src/adapters/__tests__/shared/commands/rules.test.ts`
   - **Rationale**: Tests rule management commands
   - **Difficulty**: Easy, Low mocking complexity

10. `src/adapters/__tests__/shared/commands/tasks.test.ts`
    - **Rationale**: Tests task management commands
    - **Difficulty**: Easy, Low mocking complexity

11. `src/adapters/__tests__/shared/commands/git.test.ts`
    - **Rationale**: Tests Git commands
    - **Difficulty**: Easy, Low mocking complexity

12. `src/adapters/__tests__/shared/commands/session.test.ts`
    - **Rationale**: Tests session management commands
    - **Difficulty**: Easy, Low mocking complexity

13. `src/adapters/cli/__tests__/git-merge-pr.test.ts`
    - **Rationale**: Tests PR merge functionality in CLI
    - **Difficulty**: Easy, Low mocking complexity

## Priority 4: Additional Utility Tests

These tests cover important utilities but are less critical than those above:

14. `src/utils/__tests__/param-schemas.test.ts`
    - **Rationale**: Tests parameter validation schemas
    - **Difficulty**: Easy, Low mocking complexity

15. `src/utils/__tests__/option-descriptions.test.ts`
    - **Rationale**: Tests command option descriptions
    - **Difficulty**: Easy, Low mocking complexity

16. `src/utils/test-utils/__tests__/compatibility.test.ts`
    - **Rationale**: Tests the Jest/Vitest compatibility layer
    - **Difficulty**: Medium, Low mocking complexity
    - **Note**: May contain circular dependencies as it tests compatibility itself

## Priority 5: Key Integration Tests

These integration tests verify important system behaviors:

17. `src/adapters/__tests__/integration/tasks.test.ts`
    - **Rationale**: Tests task management integration
    - **Difficulty**: Easy, Medium mocking complexity

18. `src/adapters/__tests__/integration/git.test.ts`
    - **Rationale**: Tests Git integration
    - **Difficulty**: Easy, Low mocking complexity

19. `src/adapters/__tests__/integration/rules.test.ts`
    - **Rationale**: Tests rules integration
    - **Difficulty**: Easy, Medium mocking complexity

20. `src/adapters/__tests__/integration/workspace.test.ts`
    - **Rationale**: Tests workspace management integration
    - **Difficulty**: Easy, Low mocking complexity

## Migration Order

The tests will be migrated in the priority order listed above, with the following approach:

1. First migrate Priority 1 (Core Utilities) tests
2. Then migrate Priority 2 (Core Domain) tests
3. Followed by Priority 3 (Adapter Command) tests
4. Then Priority 4 (Additional Utility) tests
5. Finally, migrate Priority 5 (Integration) tests

This order ensures that the most foundational and commonly used tests are migrated first, which will inform patterns for the remaining tests. 
