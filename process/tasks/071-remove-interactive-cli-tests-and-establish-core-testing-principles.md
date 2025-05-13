# Task #071: Remove Interactive CLI Tests and Establish Core Testing Principles

## Context

The project currently contains tests that attempt to verify interactive CLI behavior by mocking prompt libraries and simulating user input. These tests are brittle, complex, and focus on framework behavior rather than our domain logic. They also lead to TypeScript/linting errors due to inconsistent mocking approaches.

## Goal

1. Remove existing interactive CLI tests
2. Establish a clear testing rule that focuses on domain logic and prohibits testing of interactive CLI features
3. Ensure testing efforts are directed toward core business logic rather than framework implementations

## Requirements

1. **Remove Interactive Tests:**

   - Remove tests that simulate user input through @clack/prompts or similar libraries
   - Remove tests that mock interactive CLI behavior
   - Keep tests focused on the underlying domain logic

2. **Create Testing Rule:**

   - Create a new cursor rule "testing-boundaries.mdc" that defines testing principles
   - Prohibit tests that focus on interactive CLI behavior
   - Provide clear guidance on what should and shouldn't be tested

3. **Update Testing Documentation:**
   - Document the rationale for not testing interactive CLI features
   - Provide examples of appropriate test coverage
   - Clarify the boundary between domain logic and CLI implementation

## Implementation Steps

- [ ] Identify and remove interactive CLI tests across the codebase
- [ ] Create a new cursor rule "testing-boundaries.mdc" that defines testing principles
- [ ] Add explicit prohibition against testing framework internals
- [ ] Add explicit prohibition against testing interactive CLI features
- [ ] Provide examples of proper test focus on domain logic
- [ ] Update existing test files to comply with the new rule
- [ ] Add the new rule to any test-related documentation

## Verification

- [ ] All interactive CLI tests are removed
- [ ] New testing rule clearly prohibits testing of interactive CLI features
- [ ] New testing rule clearly prohibits testing framework internals
- [ ] Remaining tests pass and focus on domain logic
- [ ] Linter errors related to complex mocking are resolved
