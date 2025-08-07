# Create a Complete Test Inventory and Classification System

## Context

The project is experiencing issues with test failures when running under Bun's test runner. Recent work on improving testability through Dependency Injection (Tasks #101, #103) has not fully addressed the compatibility issues with existing tests that were written using Jest/Vitest patterns.

Currently, we have 114 failing tests with various patterns of failures, most related to incompatibilities between Jest/Vitest mocking patterns and Bun's test runner. We need a systematic approach to categorize these tests to guide our migration strategy.

This task is the first in a series aimed at improving our testing infrastructure. It will provide the foundation for subsequent tasks by creating a comprehensive inventory of our test patterns and their dependencies.

## Requirements

1. **Test Pattern Analysis**

   - Create a system to analyze and categorize all test files in the codebase
   - Identify patterns of testing, including:
     - Mocking techniques (mock functions, spy functions, module mocks)
     - Test setup and teardown patterns
     - Assertion styles used
     - Framework-specific features being used

2. **Test Classification Tooling**

   - Develop a script that can scan the codebase and classify tests
   - The script should output a structured report categorizing tests by:
     - Mock usage patterns
     - Framework dependencies
     - Migration difficulty
     - Impact on overall test stability

3. **Test Dependency Mapping**

   - Document the dependencies between test files and test utilities
   - Identify shared utilities and their usage patterns
   - Map the flow of mock objects through test files

4. **Documentation and Reporting**
   - Create a comprehensive report of findings
   - Document recommendations for migration strategy
   - Provide a prioritized list of tests to migrate based on complexity and impact

## Implementation Steps

1. [ ] Design a classification schema for test patterns:

   - [ ] Define categories for mocking patterns (function mocks, spies, module mocks)
   - [ ] Define categories for test runner features (lifecycle hooks, matchers)
   - [ ] Define complexity and impact metrics

2. [ ] Create a script to scan and analyze test files:

   - [ ] Scan for import statements to identify framework dependencies
   - [ ] Search for patterns of mock usage using AST analysis
   - [ ] Detect usage of framework-specific features
   - [ ] Count occurrences of different test patterns

3. [ ] Run the analysis on the codebase:

   - [ ] Generate raw data for all test files
   - [ ] Calculate statistics on pattern usage
   - [ ] Identify the most common patterns that need migration

4. [ ] Create visualization of test relationships:

   - [ ] Map dependencies between test files and utilities
   - [ ] Show inheritance of mock objects
   - [ ] Identify central points in the test infrastructure

5. [ ] Generate a comprehensive report:

   - [ ] Document findings from the analysis
   - [ ] Categorize tests by migration difficulty
   - [ ] Recommend migration priorities
   - [ ] Document patterns that will need special handling

6. [ ] Create a living document for tracking test migration progress:
   - [ ] Set up a system to track which tests have been migrated
   - [ ] Create metrics to measure progress
   - [ ] Define success criteria for the migration

## Verification

- [ ] The script successfully analyzes all test files in the codebase
- [ ] The classification system covers all major test patterns used
- [ ] The report provides actionable insights for test migration
- [ ] Dependencies between tests and test utilities are clearly documented
- [ ] The system provides clear guidance for subsequent migration tasks
- [ ] The classification aligns with the patterns observed in failing tests
