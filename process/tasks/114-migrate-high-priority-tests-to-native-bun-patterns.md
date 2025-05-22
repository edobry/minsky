# Task #114: Migrate High-Priority Tests to Native Bun Patterns

## Context

Our test suite currently has 114 failing tests when run under Bun's test runner due to incompatibilities between Jest/Vitest mocking patterns and Bun's testing APIs. While the "Core Mock Compatibility Layer" task will provide short-term compatibility, we need to begin actively migrating critical tests to use native Bun patterns for long-term stability and performance.

This task focuses on identifying and migrating the highest-priority tests first, leveraging the insights from the "Test Inventory and Classification" task and the documentation from the "Test Utility Documentation" task. The priority will be determined by test criticality, frequency of execution, and complexity of migration.

This task should be executed AFTER the "Test Inventory and Classification" task, the "Core Mock Compatibility Layer" task, and the "Test Utility Documentation" task, as it depends on their outputs. It can be performed in parallel with the "Automated Test Migration Script" task, with manually migrated tests serving as examples for the automated tool.

---

## Progress Summary (as of latest migration)

- **Tests migrated:** 9/20 high-priority tests (see `migration-notes.md` for details)
- **Custom assertion helpers created:** See `src/utils/test-utils/assertions.ts` for helpers like `expectToMatch`, `expectToHaveLength`, `expectToBeInstanceOf`, `expectToNotBeNull`, `expectToHaveBeenCalled`, `getMockCallArg`, etc.
- **Migration patterns documented:** See `process/tasks/114/migration-notes.md` and implementation plan for a full pattern library and lessons learned.
- **Pattern library and migration templates established.**
- **Next up:** Continue migrating adapter and utility tests in priority order.

---

## Requirements

1. **High-Priority Test Identification**

   - [x] Identify the most critical tests to migrate based on:
     - Business criticality of the functionality being tested
     - Frequency of test execution (e.g., in CI pipelines)
     - Probability of catching regressions
     - Complexity of test dependencies
   - [x] Create a prioritized list of tests for migration (see migration backlog)

2. **Manual Migration of Core Tests**

   - [x] Migrate identified high-priority tests to use:
     - Native Bun mocking patterns
     - Bun-specific assertion patterns
     - Updated module mocking approaches
     - Dependency injection where appropriate
   - [x] Ensure all migrated tests pass after migration
   - [ ] Continue migration for remaining high-priority tests

3. **Test Structure Improvement**

   - [x] Improve the structure of migrated tests:
     - Remove unnecessary test dependencies
     - Simplify complex setup and teardown
     - Enhance readability and maintainability
     - Apply consistent patterns as documented
   - [ ] Apply improvements to remaining tests as they are migrated

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

---

## Implementation Steps (Updated)

1. [x] Analyze the test inventory and create a prioritized list
2. [x] Create a migration plan for each high-priority test
3. [x] Perform the migration for the first 9 high-priority tests
4. [x] Verify each migrated test
5. [x] Document migration patterns and helpers
6. [ ] Continue migration for next priority files:
   - [ ] `src/adapters/__tests__/shared/commands/tasks.test.ts`
   - [ ] `src/adapters/__tests__/shared/commands/git.test.ts`
   - [ ] `src/adapters/__tests__/shared/commands/session.test.ts`
   - [ ] `src/adapters/cli/__tests__/git-merge-pr.test.ts`
   - [ ] `src/utils/__tests__/param-schemas.test.ts`
   - [ ] `src/utils/__tests__/option-descriptions.test.ts`
   - [ ] `src/utils/test-utils/__tests__/compatibility.test.ts`
   - [ ] Update high-priority integration tests as needed
7. [ ] Create a report on the migration effort

---

## Verification

- [x] All migrated tests pass when run with Bun's test runner
- [x] Migrated tests maintain the same coverage as the original tests
- [x] Test readability and maintainability are improved
- [x] Migration patterns are well-documented for future use
- [ ] The migration report provides valuable insights for the automated migration tool
- [ ] At least 20 high-priority tests are successfully migrated

---

## Dependencies

- This task depends on the "Test Inventory and Classification" task for identifying priority tests
- This task depends on the "Core Mock Compatibility Layer" for understanding pattern equivalences
- This task depends on the "Test Utility Documentation" task for guidance on best practices
- Insights from this task should inform the "Automated Test Migration Script" task

---

## References

- See `process/tasks/114/migration-notes.md` for detailed migration notes, patterns, and status.
- See `process/tasks/114/implementation-plan.md` for the full implementation plan and progress metrics.
