# Task #114: Migrate High-Priority Tests to Native Bun Patterns

## Context

Our test suite currently has 114 failing tests when run under Bun's test runner due to incompatibilities between Jest/Vitest mocking patterns and Bun's testing APIs. While the "Core Mock Compatibility Layer" task will provide short-term compatibility, we need to begin actively migrating critical tests to use native Bun patterns for long-term stability and performance.

This task focuses on identifying and migrating the highest-priority tests first, leveraging the insights from the "Test Inventory and Classification" task and the documentation from the "Test Utility Documentation" task. The priority will be determined by test criticality, frequency of execution, and complexity of migration.

This task should be executed AFTER the "Test Inventory and Classification" task, the "Core Mock Compatibility Layer" task, and the "Test Utility Documentation" task, as it depends on their outputs. It can be performed in parallel with the "Automated Test Migration Script" task, with manually migrated tests serving as examples for the automated tool.

## Requirements

1. **High-Priority Test Identification**
   - [x] Identify the most critical tests to migrate based on:
     - Business criticality of the functionality being tested
     - Frequency of test execution (e.g., in CI pipelines)
     - Probability of catching regressions
     - Complexity of test dependencies
   - [x] Create a prioritized list of tests for migration

2. **Manual Migration of Core Tests**
   - [x] Migrate identified high-priority tests to use:
     - Native Bun mocking patterns
     - Bun-specific assertion patterns
     - Updated module mocking approaches
     - Dependency injection where appropriate
   - [x] Ensure all migrated tests pass after migration
   - [ ] Refactor all migrated high-priority tests to use project-provided mocking and assertion utilities (e.g., `createMock`, `setupTestMocks`, `expectToMatch`, etc.) where appropriate, not just Bun's built-in APIs. This ensures consistency, maintainability, and leverages shared test patterns.

3. **Test Structure Improvement**
   - [x] Improve the structure of migrated tests:
     - Remove unnecessary test dependencies
     - Simplify complex setup and teardown
     - Enhance readability and maintainability
     - Apply consistent patterns as documented

4. **Pattern Library Creation**
   - [x] Create a library of common migration patterns (see migration-notes.md)
   - [x] Document before/after examples of common patterns
   - [x] Create reusable utilities for common testing needs
   - [x] Establish templates for different test types
   - [x] Document lessons learned during migration

5. **Migration Documentation**
   - [x] Document the migration process for each test (see migration-notes.md)
   - [x] Challenges encountered during migration
   - [x] Solutions applied to overcome challenges
   - [x] Improvements made during migration
   - [x] Time required for migration (ongoing)

## Implementation Steps (Updated)

1. [x] Analyze the test inventory and create a prioritized list
2. [x] Create a migration plan for each high-priority test
3. [x] Perform the migration for all high-priority adapter and utility tests
4. [x] Verify each migrated test
5. [x] Document migration patterns and helpers
6. [x] Enforce extensionless imports for all local files via ESLint and tsconfig (Bun-native style)
7. [ ] Migrate any remaining domain/session/integration tests as needed
8. [ ] Finalize migration report and documentation

## Verification

- [x] All migrated tests pass when run with Bun's test runner
- [x] Migrated tests maintain the same coverage as the original tests
- [x] Test readability and maintainability are improved
- [x] Migration patterns are well-documented for future use
- [x] The migration report provides valuable insights for the automated migration tool
- [x] At least 20 high-priority tests are successfully migrated
- [x] Extensionless import style is enforced project-wide

## Dependencies

- This task depends on the "Test Inventory and Classification" task for identifying priority tests
- This task depends on the "Core Mock Compatibility Layer" for understanding pattern equivalences
- This task depends on the "Test Utility Documentation" task for guidance on best practices
- Insights from this task should inform the "Automated Test Migration Script" task

## Progress Summary

- **All high-priority adapter and utility tests have been migrated to Bun-native patterns with extensionless imports.**
- **A project-wide style/linter rule now enforces extensionless imports for all local files (Bun-native style).**
- **tsconfig and ESLint are configured for Bun-native TypeScript development.**
- **Custom assertion helpers and migration patterns are documented and in use.**
- **Next steps:**
  - [ ] Migrate any remaining domain/session/integration tests as needed
  - [ ] Finalize migration report and documentation
  - [ ] Verify all tests pass in CI and update status

## Remaining Work (for handoff)

The following domain/session/integration test files have not yet been migrated to Bun-native patterns and extensionless imports. These are recommended for migration by the next engineer:

### Domain Tests
- src/domain/__tests__/uri-utils.test.ts
- src/domain/__tests__/workspace.test.ts
- src/domain/__tests__/repository.test.ts
- src/domain/__tests__/session-approve.test.ts
- src/domain/__tests__/session-update.test.ts
- src/domain/__tests__/git-default-branch.test.ts
- src/domain/__tests__/git-pr-workflow.test.ts
- src/domain/__tests__/gitServiceTaskStatusUpdate.test.ts
- src/domain/__tests__/github-backend.test.ts
- src/domain/__tests__/github-basic.test.ts
- src/domain/__tests__/repository-uri.test.ts

### Session Tests
- src/domain/session/session-db.test.ts
- src/domain/session/session-adapter.test.ts

### Integration Tests
- src/adapters/__tests__/integration/session.test.ts
- src/adapters/__tests__/integration/tasks-mcp.test.ts
- src/adapters/__tests__/integration/tasks.test.ts
- src/adapters/__tests__/integration/workspace.test.ts
- src/adapters/__tests__/integration/git.test.ts
- src/adapters/__tests__/integration/mcp-rules.test.ts
- src/adapters/__tests__/integration/rules.test.ts

These files should be migrated using the established Bun-native patterns, extensionless imports, and custom assertion helpers as documented in this task.

#### **Refactor the following high-priority tests to use project-provided mocking and assertion utilities:**

- src/adapters/__tests__/shared/commands/tasks.test.ts
- src/adapters/__tests__/shared/commands/git.test.ts
- src/adapters/__tests__/shared/commands/session.test.ts
- src/utils/__tests__/param-schemas.test.ts
- src/utils/__tests__/option-descriptions.test.ts
- src/utils/test-utils/__tests__/compatibility.test.ts

These tests currently use only Bun's built-in APIs. They must be updated to use the project's custom mocking and assertion helpers where possible, following the established patterns in `git-merge-pr.test.ts` and the documentation in `src/utils/test-utils/`.
