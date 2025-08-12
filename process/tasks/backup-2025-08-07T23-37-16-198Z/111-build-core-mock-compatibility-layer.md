# Build Core Mock Compatibility Layer

## Context

Our test suite relies heavily on Jest/Vitest-style mocking patterns, but we're experiencing significant failures (114 failing tests) when running under Bun's test runner. Recent work on improving testability through Dependency Injection (Tasks #101, #103) has improved the application architecture but did not address the fundamental compatibility issues between testing frameworks.

The test failures are primarily related to missing or incompatible mock methods and features:

1. Missing mock function methods like `mockReset()` and `mockClear()`
2. Incompatible asymmetric matchers (`expect.anything()`, etc.)
3. Different module mocking approaches

This task is part of a structured plan to improve our testing infrastructure, and depends on insights from the "Test Inventory and Classification" task to ensure we address the most critical patterns.

## Requirements

1. **Mock Function API Compatibility**

   - Implement comprehensive compatibility for Jest/Vitest mock function APIs
   - Support all commonly used methods including:
     - `mockReset()`, `mockClear()`, `mockRestore()`
     - `mockImplementation()`, `mockImplementationOnce()`
     - `mockReturnValue()`, `mockReturnValueOnce()`
     - `mockResolvedValue()`, `mockRejectedValue()`

2. **Asymmetric Matcher Support**

   - Create compatible implementations of asymmetric matchers:
     - `expect.anything()`, `expect.any()`
     - `expect.stringContaining()`, `expect.stringMatching()`
     - `expect.objectContaining()`, `expect.arrayContaining()`
   - Ensure these matchers work with Bun's `expect` assertions

3. **Module Mocking Bridge**

   - Create a bridge between Jest's `jest.mock()` pattern and Bun's `mock.module()`
   - Support auto-mocking of module dependencies
   - Handle hoisting and module initialization timing differences

4. **Integration with Bun's Test Runner**

   - Ensure the compatibility layer integrates seamlessly with Bun's test runner
   - Handle test lifecycle hooks properly
   - Support proper test isolation

5. **Documentation and Usage Guidelines**
   - Document the compatibility layer's capabilities and limitations
   - Provide clear examples of how to use it in tests
   - Include migration guidance for test patterns not fully supported

## Implementation Steps

1. [ ] Review failure patterns from the "Test Inventory and Classification" task:

   - [ ] Identify the most critical mock APIs to implement
   - [ ] Prioritize based on usage frequency and impact

2. [ ] Implement core mock function compatibility:

   - [ ] Create a wrapper around Bun's `mock()` function
   - [ ] Implement all required mock function methods
   - [ ] Ensure proper tracking of calls, arguments, and results

3. [ ] Create asymmetric matcher compatibility:

   - [ ] Implement core matcher functions
   - [ ] Ensure they integrate with Bun's assertion engine
   - [ ] Add support for custom matchers if needed

4. [ ] Develop module mocking utilities:

   - [ ] Create a bridge to Bun's `mock.module()`
   - [ ] Handle module initialization timing
   - [ ] Support common module mocking patterns

5. [ ] Create test utilities for setup and teardown:

   - [ ] Support `beforeEach`/`afterEach` patterns for mock cleanup
   - [ ] Provide utilities for resetting all mocks

6. [ ] Build comprehensive tests for the compatibility layer:

   - [ ] Test all mock function methods
   - [ ] Test all asymmetric matchers
   - [ ] Test module mocking capabilities

7. [ ] Document the compatibility layer:
   - [ ] Create usage guidelines
   - [ ] Document any limitations or differences from Jest/Vitest
   - [ ] Provide migration examples

## Verification

- [ ] All implemented mock methods behave as expected in tests
- [ ] Asymmetric matchers correctly validate values
- [ ] Module mocks properly override modules
- [ ] Previously failing tests that use these patterns now pass
- [ ] The implementation avoids adding unnecessary complexity
- [ ] Documentation is clear and provides actionable guidance
- [ ] The compatibility layer can be gradually removed as tests are migrated
