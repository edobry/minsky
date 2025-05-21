# Task #114: Migrate High-Priority Tests to Native Bun Patterns

## Context

Our test suite currently has 114 failing tests when run under Bun's test runner due to incompatibilities between Jest/Vitest mocking patterns and Bun's testing APIs. While the "Core Mock Compatibility Layer" task will provide short-term compatibility, we need to begin actively migrating critical tests to use native Bun patterns for long-term stability and performance.

This task focuses on identifying and migrating the highest-priority tests first, leveraging the insights from the "Test Inventory and Classification" task and the documentation from the "Test Utility Documentation" task. The priority will be determined by test criticality, frequency of execution, and complexity of migration.

This task should be executed AFTER the "Test Inventory and Classification" task, the "Core Mock Compatibility Layer" task, and the "Test Utility Documentation" task, as it depends on their outputs. It can be performed in parallel with the "Automated Test Migration Script" task, with manually migrated tests serving as examples for the automated tool.

## Requirements

1. **High-Priority Test Identification**

   - Identify the most critical tests to migrate based on:
     - Business criticality of the functionality being tested
     - Frequency of test execution (e.g., in CI pipelines)
     - Probability of catching regressions
     - Complexity of test dependencies
   - Create a prioritized list of tests for migration

2. **Manual Migration of Core Tests**

   - Migrate identified high-priority tests to use:
     - Native Bun mocking patterns
     - Bun-specific assertion patterns
     - Updated module mocking approaches
     - Dependency injection where appropriate
   - Ensure all tests pass after migration

3. **Test Structure Improvement**

   - Improve the structure of migrated tests:
     - Remove unnecessary test dependencies
     - Simplify complex setup and teardown
     - Enhance readability and maintainability
     - Apply consistent patterns as documented

4. **Pattern Library Creation**

   - Create a library of common migration patterns:
     - Document before/after examples of common patterns
     - Create reusable utilities for common testing needs
     - Establish templates for different test types
     - Document lessons learned during migration

5. **Migration Documentation**
   - Document the migration process for each test:
     - Challenges encountered during migration
     - Solutions applied to overcome challenges
     - Improvements made during migration
     - Time required for migration

## Implementation Steps

1. [x] Analyze the test inventory and create a prioritized list:

   - [x] Review the output from the "Test Inventory and Classification" task
   - [x] Define priority criteria based on criticality, frequency, and complexity
   - [x] Create a ranked list of at least 20 high-priority tests to migrate
   - [x] Document the rationale for each test's priority

2. [x] Create a migration plan for each high-priority test:

   - [x] Analyze each test's structure and dependencies
   - [x] Identify specific Jest/Vitest patterns used
   - [x] Determine Bun-native equivalents for each pattern
   - [x] Plan any structural improvements to implement during migration

3. [x] Create custom assertion helpers to bridge Jest/Bun differences:

   - [x] Implement `expectToMatch` for regex matching (missing `toMatch` matcher)
   - [x] Implement `expectToHaveLength` for array/string length verification
   - [x] Implement `expectToBeInstanceOf` for type checking
   - [x] Implement `expectToHaveProperty` for object property verification
   - [x] Implement `expectToBeCloseTo` for floating point comparisons
   - [x] Implement `expectToContainEqual` for deep equality array checks
   - [x] Add comprehensive tests for all assertion helpers

4. [✓] Perform the migration for each test (in progress):

   - [x] Successfully migrated `src/utils/test-utils/__tests__/enhanced-utils.test.ts`
   - [x] Successfully migrated `src/utils/test-utils/__tests__/mocking.test.ts`
   - [x] Successfully migrated `src/utils/filter-messages.test.ts`
   - [ ] Continue with remaining high-priority tests

5. [x] Verify each migrated test:

   - [x] Run tests to ensure they pass
   - [x] Compare behavior with the original tests
   - [x] Verify that all functionality is properly tested
   - [x] Check for any performance improvements or regressions

6. [x] Document migration patterns:

   - [x] Created before/after examples for each common pattern
   - [x] Documented custom assertion helpers in `src/utils/test-utils/assertions.ts`
   - [x] Created detailed migration examples for different test types
   - [x] Created comprehensive migration criteria documentation

7. [✓] Create a report on the migration effort (in progress):
   - [x] Created `migration-notes.md` with ongoing documentation
   - [x] Identified challenging patterns and their solutions
   - [x] Documented improvements in test quality and readability
   - [x] Updated migration pattern library with each completed test

## Verification

- [✓] All migrated tests pass when run with Bun's test runner (ongoing)
- [x] Migrated tests maintain the same coverage as the original tests
- [x] Test readability and maintainability are improved
- [x] Migration patterns are well-documented for future use
- [✓] The migration report provides valuable insights for the automated migration tool (ongoing)
- [ ] At least 20 high-priority tests are successfully migrated (3 of 20 completed)

## Dependencies

- This task depends on the "Test Inventory and Classification" task for identifying priority tests
- This task depends on the "Core Mock Compatibility Layer" for understanding pattern equivalences
- This task depends on the "Test Utility Documentation" task for guidance on best practices
- Insights from this task should inform the "Automated Test Migration Script" task

## Progress Summary

So far, we have:

1. **Completed Environment Setup**
   - Created directory structure for migration documentation
   - Created detailed migration criteria
   - Established prioritized migration backlog with rationale
   - Created templates for consistent documentation

2. **Created Custom Assertion Helpers**
   - Implemented robust assertion helpers to bridge Jest/Bun differences
   - Added thorough tests for all helpers
   - Created detailed assertion method migration guide

3. **Successfully Migrated Core Tests**
   - Migrated enhanced-utils.test.ts - Fixed ESM imports and lifecycle hooks
   - Migrated mocking.test.ts - Improved type safety and error verification
   - Migrated filter-messages.test.ts - Used custom assertion helpers

4. **Documented Migration Patterns and Lessons Learned**
   - ESM Import Requirements (file extensions)
   - Lifecycle Hook Imports (explicit imports needed)
   - Assertion Method Differences (custom helpers)
   - Type Safety Improvements (proper assertions)
   - Documentation Benefits (migration tracking)

The next steps are to continue migrating the remaining high-priority tests, refine our migration approach based on lessons learned, and continue documenting patterns for future reference.
