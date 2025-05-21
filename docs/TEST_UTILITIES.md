# Minsky Test Utilities Documentation

This document provides comprehensive guidance on testing approaches, utilities, and best practices for the Minsky project. It aims to clarify our testing infrastructure as we transition from Jest/Vitest patterns to Bun's test runner with improved Dependency Injection.

## Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
3. [Core Testing Utilities](#core-testing-utilities)
   - [Mocking Utilities](#mocking-utilities)
   - [Dependency Injection Utilities](#dependency-injection-utilities)
   - [Test Data Generation](#test-data-generation)
   - [Assertions and Expectations](#assertions-and-expectations)
4. [Compatibility Layer](#compatibility-layer)
   - [Mock Functions](#mock-functions)
   - [Asymmetric Matchers](#asymmetric-matchers)
   - [Module Mocking](#module-mocking)
5. [Migration Guides](#migration-guides)
   - [Function Mocking](#function-mocking-migration)
   - [Module Mocking](#module-mocking-migration)
   - [Assertions](#assertions-migration)
   - [Test Setup and Teardown](#test-setup-and-teardown-migration)
6. [Best Practices](#best-practices)
   - [Test Organization](#test-organization)
   - [Mocking Strategies](#mocking-strategies)
   - [Dependency Injection in Tests](#dependency-injection-in-tests)
   - [Test Data Management](#test-data-management)
7. [Test Architecture](#test-architecture)
   - [Component Relationships](#component-relationships)
   - [Test Execution Flow](#test-execution-flow)
   - [Compatibility Layer Design](#compatibility-layer-design)
8. [Testing Workflows](#testing-workflows)
   - [Running Tests](#running-tests)
   - [Debugging Tests](#debugging-tests)
   - [CI/CD Integration](#ci-cd-integration)
9. [Examples and Practical Guides](#examples-and-practical-guides)
10. [FAQ and Troubleshooting](#faq-and-troubleshooting)
11. [Contributing](#contributing)

## Introduction

The Minsky project is transitioning from Jest/Vitest-based testing patterns to Bun's native test runner with improved Dependency Injection. This transition brings several benefits including:

- **Performance**: Bun's test runner is significantly faster than Jest
- **Simplicity**: Less configuration and setup overhead
- **Modern features**: Better support for ESM and TypeScript
- **Improved architecture**: Moving toward more maintainable Dependency Injection patterns

However, this transition also introduces challenges, particularly when it comes to existing tests that rely on Jest/Vitest-specific features. This documentation aims to provide clear guidance on:

1. How to use our existing test utilities effectively
2. How to leverage the compatibility layer for Jest/Vitest features
3. How to migrate tests to use native Bun patterns
4. Best practices for writing new tests

## Getting Started

### Basic Test Setup

To create a new test file in the Minsky project, use the following template:

```typescript
/**
 * Tests for [component being tested]
 */
import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("Component Name", () => {
  test("should do something specific", () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Using Compatibility Layer

If you need Jest/Vitest compatibility features, use this template:

```typescript
/**
 * Tests for [component being tested]
 */
import { describe, test, expect } from "bun:test";
import { setupTestCompat, createCompatMock, jest } from "../utils/test-utils/compatibility";

// Set up the compatibility layer
setupTestCompat();

describe("Component Name", () => {
  test("should do something with mocks", () => {
    // Create a Jest-like mock
    const mockFn = createCompatMock();
    mockFn.mockReturnValue("test");
    
    // Use the mock
    const result = mockFn();
    
    // Assert with regular Bun expectations
    expect(result).toBe("test");
    expect(mockFn).toHaveBeenCalled();
  });
});
```

## Core Testing Utilities

For detailed documentation of all the mocking utilities available in the Minsky codebase, see [MOCKING_UTILITIES.md](MOCKING_UTILITIES.md).

This documentation covers:

- Basic mocking with `createMock` and `mockFunction`
- Module mocking with `mockModule`
- Enhanced mocking with `createMockObject` and `createPartialMock`
- Mock filesystems with `createMockFileSystem`
- Dependency utilities with `createTestDeps` and `createTaskTestDeps`

### Dependency Injection Utilities

Dependency Injection is a key pattern for making tests maintainable and isolated. Our testing utilities support this approach with:

- Factory functions for creating objects with injected dependencies
- Dependency containers for more complex scenarios
- Test-specific dependency helpers

## Compatibility Layer

For detailed documentation of the Jest/Vitest compatibility layer, see [COMPATIBILITY_LAYER.md](COMPATIBILITY_LAYER.md).

This documentation covers:

- Mock functions with the Jest-like API
- Asymmetric matchers (e.g., `expect.anything()`, `expect.any()`)
- Module mocking with `jest.mock()`
- Limitations and migration strategies

## Migration Guides

For step-by-step guides on migrating tests from Jest/Vitest to Bun, see [MIGRATION_GUIDES.md](MIGRATION_GUIDES.md).

These guides cover:

- Migrating function mocking
- Migrating module mocking
- Updating assertion patterns
- Handling test lifecycle methods
- Common pitfalls and their solutions

## Best Practices

For comprehensive best practices for writing effective tests, see [TESTING_BEST_PRACTICES.md](TESTING_BEST_PRACTICES.md).

These best practices cover:

- Test structure and organization
- Naming conventions
- Mocking strategies
- Dependency injection
- Assertion patterns
- Test data management
- Performance considerations
- Debugging tests
- Anti-patterns to avoid

## Test Architecture

### Component Relationships

The testing infrastructure consists of several key components:

1. **Core Test Utilities**: Base utilities for mocking, assertions, and test setup
2. **Compatibility Layer**: Bridge between Jest/Vitest patterns and Bun
3. **Dependency Injection Utilities**: Tools for creating testable code with DI
4. **Test Data Factories**: Utilities for generating test data
5. **Bun Test Integration**: Integration with Bun's native test runner

```
┌───────────────────────┐
│    Test Execution     │
│  (Bun Test Runner)    │
└───────────┬───────────┘
            │
┌───────────▼───────────┐     ┌───────────────────────┐
│  Core Test Utilities  │◄────┤ Compatibility Layer   │
└───────────┬───────────┘     └───────────────────────┘
            │
┌───────────▼───────────┐     ┌───────────────────────┐
│ Dependency Injection  │◄────┤   Test Data Factories │
│       Utilities       │     └───────────────────────┘
└───────────────────────┘
```

### Test Execution Flow

The typical flow of test execution is:

1. **Setup**: Import utilities and set up the test environment
2. **Arrange**: Prepare test data and mock dependencies
3. **Act**: Execute the code being tested
4. **Assert**: Verify the expected outcomes
5. **Cleanup**: Reset mocks and cleanup resources

### Compatibility Layer Design

The compatibility layer is designed to:

1. **Minimize Migration Effort**: Allow existing tests to work with minimal changes
2. **Provide a Transition Path**: Support gradual migration to native Bun patterns
3. **Maintain Performance**: Keep overhead minimal while providing compatibility
4. **Support Clean Code**: Encourage good testing practices even during transition

## Testing Workflows

### Running Tests

To run tests in the Minsky project:

```bash
# Run all tests
bun test

# Run tests in a specific file
bun test path/to/file.test.ts

# Run tests matching a pattern
bun test --pattern "UserService"

# Run tests with coverage
bun test --coverage
```

### Debugging Tests

For debugging test failures:

1. Use `console.log` statements strategically
2. Run specific tests with `bun test path/to/file.test.ts`
3. Use `test.only()` to focus on a specific test
4. Check for dependency issues
5. Verify that mocks are set up correctly

### CI/CD Integration

Tests run automatically in our CI/CD pipeline:

1. On pull requests to verify changes
2. On main branch to ensure stability
3. During deployment to verify production readiness

## Examples and Practical Guides

For practical examples of how to write tests in the Minsky project, see [EXAMPLE_GUIDE.md](EXAMPLE_GUIDE.md).

This guide provides concrete examples of:

- Basic test structures
- Mocking different types of dependencies
- Using the compatibility layer
- Dependency injection patterns
- Integration testing approaches
- Advanced testing patterns

These examples demonstrate real-world usage of the testing utilities and patterns described in this documentation.

## FAQ and Troubleshooting

### Common Issues

**Q: Why are my mocks not working?**  
A: Check that you're creating mocks before they're used, and that you're using the right mocking approach for your scenario. For module mocks, ensure you're mocking before importing.

**Q: How do I test asynchronous code?**  
A: Use `async/await` with your test functions, and make sure you're awaiting all promises.

**Q: My tests are interfering with each other. What should I do?**  
A: Make sure each test is isolated and doesn't depend on global state. Use `beforeEach` to set up fresh state for each test.

**Q: How do I mock a module that uses ESM imports?**  
A: Use the compatibility layer's `jest.mock()` function, or refactor to use dependency injection.

### Getting Help

If you encounter issues not covered in this documentation:

1. Check for similar issues in our issue tracker
2. Ask in the #testing channel in Slack
3. Consult with the testing infrastructure team

## Contributing

We welcome contributions to our testing infrastructure:

- **Bug Reports**: If you find issues with the testing utilities, report them
- **Enhancements**: Suggest improvements to the testing utilities
- **Documentation**: Help improve this documentation
- **Test Utilities**: Contribute new testing utilities or improve existing ones

To contribute:

1. Create a new branch
2. Make your changes
3. Add or update tests
4. Update documentation
5. Submit a pull request 
