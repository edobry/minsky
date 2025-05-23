# Jest/Vitest Compatibility Layer for Bun Tests

This document describes the Jest/Vitest compatibility layer that can be used to migrate tests to Bun's test runner while keeping most of the familiar Jest/Vitest-style patterns.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Mock Functions](#mock-functions)
  - [Creating Mocks](#creating-mocks)
  - [Mock Implementations](#mock-implementations)
  - [Working with Return Values](#working-with-return-values)
  - [Other Mock Utilities](#other-mock-utilities)
- [Asymmetric Matchers](#asymmetric-matchers)
  - [Basic Matchers](#basic-matchers)
  - [String Matchers](#string-matchers)
  - [Object/Array Matchers](#objectarray-matchers)
  - [Custom Matchers](#custom-matchers)
- [Module Mocking](#module-mocking)
  - [Basic Module Mocking](#basic-module-mocking)
  - [Advanced Module Mocking](#advanced-module-mocking)
- [Migration Guide](#migration-guide)
  - [Step 1: Update Imports](#step-1-update-imports)
  - [Step 2: Set Up Compatibility Layer](#step-2-set-up-compatibility-layer)
  - [Step 3: Update Mock Functions](#step-3-update-mock-functions)
  - [Step 4: Update Matchers](#step-4-update-matchers)
  - [Step 5: Update Module Mocks](#step-5-update-module-mocks)
- [Troubleshooting](#troubleshooting)

## Overview

The compatibility layer provides the following features:

1. **Mock Functions**: All the familiar `.mockReturnValue()`, `.mockImplementation()`, `.mockReset()`, etc. methods.
2. **Asymmetric Matchers**: `expect.anything()`, `expect.any()`, `expect.objectContaining()`, etc.
3. **Module Mocking**: Easy-to-use module mocking with a Jest-like API.

This layer is designed to make migration from Jest/Vitest to Bun as smooth as possible.

## Getting Started

To use the compatibility layer, import it at the top of your test file:

```typescript
import { describe, test, expect } from "bun:test";
import { compat, setupJestCompat } from "../../utils/test-utils";

// Set up the compatibility layer
setupJestCompat();
```

Then you can start using the compatibility features in your tests.

## Mock Functions

### Creating Mocks

```typescript
// Create a simple mock function
const mockFn = compat.createCompatMock();

// Create a mock with a default implementation
const greet = compat.createCompatMock((name: string) => `Hello, ${name}!`);

// Create a strongly typed mock
type Calculator = (a: number, b: number) => number;
const add = compat.createTypedMock<Calculator>((a, b) => a + b);
```

### Mock Implementations

```typescript
// Set an implementation
mockFn.mockImplementation(() => "mocked result");

// Set a one-time implementation
mockFn.mockImplementationOnce(() => "first call result");
mockFn.mockImplementationOnce(() => "second call result");
```

### Working with Return Values

```typescript
// Set a return value
mockFn.mockReturnValue("mocked value");

// Set a one-time return value
mockFn.mockReturnValueOnce("first call");
mockFn.mockReturnValueOnce("second call");

// Promise return values
asyncMock.mockResolvedValue("resolved value");
asyncMock.mockRejectedValue(new Error("mock error"));

// One-time promise return values
asyncMock.mockResolvedValueOnce("first resolved");
asyncMock.mockRejectedValueOnce(new Error("first error"));
```

### Other Mock Utilities

```typescript
// Clear mock call data
mockFn.mockClear(); // Clears call data but keeps implementation

// Reset mock completely
mockFn.mockReset(); // Clears call data and implementation

// Create a spy on an object method
const object = {
  method: () => "original",
};
const spy = compat.spyOn(object, "method");

// Auto-mock an entire module
const autoMocked = compat.autoMockModule(originalModule);
```

## Asymmetric Matchers

The compatibility layer provides all the familiar asymmetric matchers from Jest/Vitest.

### Basic Matchers

```typescript
// Match anything except null and undefined
expect(value).toEqual(expect.anything());

// Match any instance of a class or type
expect("string").toEqual(expect.any(String));
expect(123).toEqual(expect.any(Number));
expect(new Date()).toEqual(expect.any(Date));
```

### String Matchers

```typescript
// Match a string containing a substring
expect("hello world").toEqual(expect.stringContaining("world"));

// Match a string using a regular expression
expect("hello 123").toEqual(expect.stringMatching(/\d+/));
```

### Object/Array Matchers

```typescript
// Match an object containing specific properties
expect({ name: "John", age: 30 }).toEqual(
  expect.objectContaining({
    name: "John",
  })
);

// Match an array containing specific items
expect([1, 2, 3, 4]).toEqual(expect.arrayContaining([2, 3]));
```

### Custom Matchers

You can also create custom matchers by implementing the `AsymmetricMatcher` interface:

```typescript
import { AsymmetricMatcher } from "../../utils/test-utils/compatibility";

class IsEvenMatcher implements AsymmetricMatcher {
  asymmetricMatch(other: unknown): boolean {
    return typeof other === "number" && other % 2 === 0;
  }

  toString(): string {
    return "IsEven";
  }

  toJSON(): string {
    return "IsEven";
  }
}

// Use the custom matcher
expect(2).toEqual(new IsEvenMatcher());
```

## Module Mocking

### Basic Module Mocking

```typescript
// Mock a module with a factory function
compat.mockModule("../path/to/module", () => ({
  someFunction: compat.createCompatMock().mockReturnValue("mocked value"),
  someProperty: "mocked property",
}));

// Use Jest-like syntax
compat.jest.mock("../path/to/module", () => ({
  someFunction: compat.createCompatMock(),
}));
```

### Advanced Module Mocking

```typescript
// Mock a specific function in a module
compat.mockModuleFunction("../path/to/module", "specificFunction", () => "mocked result");

// Get a mocked module
const mockedModule = compat.getMockModule("../path/to/module");

// Restore a mocked module
compat.restoreModule("../path/to/module");

// Restore all mocked modules
compat.restoreAllModules();
```

## Migration Guide

### Step 1: Update Imports

Replace Jest/Vitest imports with Bun imports and import the compatibility layer.

```typescript
// Before
import { describe, it, expect, jest } from "jest";

// After
import { describe, test, expect } from "bun:test";
import { compat, setupJestCompat } from "../../utils/test-utils";

// Set up compatibility
setupJestCompat();
```

### Step 2: Set Up Compatibility Layer

Call `setupJestCompat()` at the top of your test file to set up the compatibility layer.

### Step 3: Update Mock Functions

Replace Jest/Vitest mock functions with compatibility mock functions.

```typescript
// Before
const mockFn = jest.fn();

// After
const mockFn = compat.createCompatMock();
```

### Step 4: Update Matchers

Use the compatibility matchers.

```typescript
// Before
expect(obj).toEqual(expect.objectContaining({ id: 123 }));

// After - should work the same since the compatibility layer registers these matchers
expect(obj).toEqual(expect.objectContaining({ id: 123 }));

// Alternative approach if you have TypeScript issues
const matchers = compat.asymmetricMatchers;
expect(obj).toEqual(matchers.objectContaining({ id: 123 }));
```

### Step 5: Update Module Mocks

Replace Jest/Vitest module mocking with compatibility module mocking.

```typescript
// Before
jest.mock("../path/to/module", () => ({
  someFunction: jest.fn().mockReturnValue("mocked"),
}));

// After
compat.jest.mock("../path/to/module", () => ({
  someFunction: compat.createCompatMock().mockReturnValue("mocked"),
}));
```

## Troubleshooting

### TypeScript Issues with Matchers

If you're having TypeScript issues with the asymmetric matchers, you can directly use the matchers from the compatibility layer:

```typescript
import { compat } from "../../utils/test-utils";
const { anything, any, objectContaining } = compat.asymmetricMatchers;

// Use the matchers directly
expect(value).toEqual(anything());
expect(value).toEqual(any(String));
expect(obj).toEqual(objectContaining({ id: 123 }));
```

### Module Mocking Issues

If you're having issues with module mocking, make sure you're mocking the module before it's imported in your test:

```typescript
// Do this at the top of your file
compat.mockModule("../module/to/mock", () => mockImplementation);

// Then import other modules that might depend on the mocked module
import { SomeComponent } from "../components/SomeComponent";
```

### Reset Issues

If tests are affecting each other, make sure you're resetting mocks between tests:

```typescript
beforeEach(() => {
  // Reset all mocks
  compat.resetAllMocks();
});
```
