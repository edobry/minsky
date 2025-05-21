# Jest/Vitest Compatibility Layer

The compatibility layer provides a bridge between Jest/Vitest testing patterns and Bun's native test runner. It allows tests written for Jest/Vitest to work with minimal changes in the Bun environment.

## Table of Contents

1. [Overview](#overview)
2. [Setup](#setup)
3. [Mock Functions](#mock-functions)
   - [Creating Mocks](#creating-mocks)
   - [Mock Tracking](#mock-tracking)
   - [Mock API Reference](#mock-api-reference)
4. [Asymmetric Matchers](#asymmetric-matchers)
   - [Available Matchers](#available-matchers)
   - [Custom Matchers](#custom-matchers)
5. [Module Mocking](#module-mocking)
   - [Basic Module Mocking](#basic-module-mocking)
   - [Auto Mocking](#auto-mocking)
   - [Selective Mocking](#selective-mocking)
6. [Migration Strategies](#migration-strategies)
7. [Limitations](#limitations)
8. [Examples](#examples)

## Overview

The compatibility layer consists of several components that emulate Jest/Vitest functionality:

1. **Mock Functions**: Implementations of Jest's `jest.fn()` with methods like `mockReturnValue()` and `mockImplementation()`
2. **Asymmetric Matchers**: Support for matchers like `expect.anything()` and `expect.objectContaining()`
3. **Module Mocking**: A system similar to Jest's `jest.mock()` for mocking entire modules

All these components are designed to work seamlessly with Bun's test runner while providing the familiar Jest/Vitest API.

## Setup

To use the compatibility layer, add the following to your test file:

```typescript
import { describe, test, expect } from "bun:test";
import { setupTestCompat, createCompatMock, jest } from "../utils/test-utils/compatibility";

// Set up the compatibility layer
setupTestCompat();
```

## Mock Functions

### Creating Mocks

The compatibility layer provides several ways to create mock functions:

```typescript
// Basic mock function (similar to jest.fn())
const mockFn = createCompatMock();

// Mock with implementation
const mockGreet = createCompatMock((name: string) => `Hello, ${name}!`);

// Typed mock function
type UserFn = (id: number) => Promise<User>;
const mockUserFn = mockFunction<UserFn>();
```

### Mock Tracking

Mock functions track their calls and results automatically:

```typescript
// Call the mock
mockFn("test", 123);

// Access tracking data
expect(mockFn.mock.calls.length).toBe(1);
expect(mockFn.mock.calls[0][0]).toBe("test");
expect(mockFn.mock.calls[0][1]).toBe(123);
```

### Mock API Reference

Mock functions provide the following Jest/Vitest-compatible methods:

| Method | Description | Example |
|--------|-------------|---------|
| `mockClear()` | Clears the mock's call history | `mockFn.mockClear()` |
| `mockReset()` | Clears call history and implementation | `mockFn.mockReset()` |
| `mockRestore()` | Restores original implementation (for spies) | `mockFn.mockRestore()` |
| `mockImplementation()` | Sets a new implementation | `mockFn.mockImplementation(() => 42)` |
| `mockImplementationOnce()` | Sets a one-time implementation | `mockFn.mockImplementationOnce(() => 42)` |
| `mockReturnValue()` | Sets a return value | `mockFn.mockReturnValue(42)` |
| `mockReturnValueOnce()` | Sets a one-time return value | `mockFn.mockReturnValueOnce(42)` |
| `mockResolvedValue()` | Sets a promise resolved value | `mockFn.mockResolvedValue(user)` |
| `mockResolvedValueOnce()` | Sets a one-time promise resolved value | `mockFn.mockResolvedValueOnce(user)` |
| `mockRejectedValue()` | Sets a promise rejected value | `mockFn.mockRejectedValue(error)` |
| `mockRejectedValueOnce()` | Sets a one-time promise rejected value | `mockFn.mockRejectedValueOnce(error)` |

## Asymmetric Matchers

Asymmetric matchers allow you to create flexible assertions that match a broader range of values.

### Available Matchers

```typescript
import { asymmetricMatchers } from "../utils/test-utils/compatibility";

// Create matchers
const anything = asymmetricMatchers.anything();
const anyString = asymmetricMatchers.any(String);
const containsText = asymmetricMatchers.stringContaining("text");
const matchesPattern = asymmetricMatchers.stringMatching(/pattern/);
const hasProperties = asymmetricMatchers.objectContaining({ id: 1 });
const containsItems = asymmetricMatchers.arrayContaining([1, 2]);

// Use them in assertions
expect({ id: 1, name: "test" }).toEqual(hasProperties);
```

The following asymmetric matchers are available:

| Matcher | Description | Example |
|---------|-------------|---------|
| `anything()` | Matches anything except null/undefined | `expect(value).toEqual(anything())` |
| `any(constructor)` | Matches instances of a type | `expect("test").toEqual(any(String))` |
| `stringContaining(str)` | Matches strings containing a substring | `expect("hello world").toEqual(stringContaining("world"))` |
| `stringMatching(regex)` | Matches strings against a pattern | `expect("test123").toEqual(stringMatching(/\d+$/))` |
| `objectContaining(obj)` | Matches objects with at least the specified properties | `expect({ a: 1, b: 2 }).toEqual(objectContaining({ a: 1 }))` |
| `arrayContaining(arr)` | Matches arrays containing at least the specified items | `expect([1, 2, 3]).toEqual(arrayContaining([1, 2]))` |

### Custom Matchers

You can create custom asymmetric matchers by implementing the `AsymmetricMatcher` interface:

```typescript
import { AsymmetricMatcher } from "../utils/test-utils/compatibility";

class EvenNumberMatcher implements AsymmetricMatcher {
  asymmetricMatch(value: unknown): boolean {
    return typeof value === 'number' && value % 2 === 0;
  }
  
  toString(): string {
    return 'EvenNumber';
  }
  
  toJSON(): string {
    return 'EvenNumber';
  }
}

const isEvenNumber = () => new EvenNumberMatcher();
```

## Module Mocking

### Basic Module Mocking

You can mock entire modules using the Jest-like global object:

```typescript
import { jest } from "../utils/test-utils/compatibility";

jest.mock("../path/to/module", () => ({
  someFunction: jest.fn().mockReturnValue("mocked value"),
  someProperty: "mocked property"
}));
```

### Auto Mocking

Auto mocking can create mocks based on the original module:

```typescript
jest.mock("../path/to/module", () => {
  const actualModule = jest.requireActual("../path/to/module");
  return {
    ...actualModule,
    someFunction: jest.fn().mockReturnValue("mocked value")
  };
});
```

### Selective Mocking

You can also mock specific functions from a module:

```typescript
import { mockModuleFunction } from "../utils/test-utils/compatibility";

mockModuleFunction(
  "../path/to/module",
  "specificFunction",
  () => "mocked result"
);
```

## Migration Strategies

When using the compatibility layer, consider these migration strategies:

1. **Gradual Migration**: Use the compatibility layer as a bridge while gradually migrating tests to native Bun patterns
2. **Hybrid Approach**: Use native Bun features where possible and the compatibility layer only for specific Jest/Vitest features
3. **Full Migration**: Eventually remove dependency on the compatibility layer for improved performance and simplicity

## Limitations

The compatibility layer has a few limitations compared to Jest/Vitest:

1. **Performance**: The compatibility layer adds overhead compared to native Bun tests
2. **Complete API Coverage**: Not all Jest/Vitest APIs are implemented
3. **ESM Limitations**: Some module mocking features may not work with certain ESM patterns
4. **Integration with Third-party Tools**: Tools designed for Jest may not work with the compatibility layer

## Examples

### Basic Mock Example

```typescript
import { describe, test, expect } from "bun:test";
import { setupTestCompat, createCompatMock } from "../utils/test-utils/compatibility";

setupTestCompat();

describe("UserService", () => {
  test("getUserName should return formatted name", () => {
    // Set up mocks
    const mockApi = {
      fetchUser: createCompatMock().mockResolvedValue({
        id: 1,
        firstName: "John",
        lastName: "Doe"
      })
    };
    
    const userService = createUserService(mockApi);
    
    // Test the service
    return userService.getUserName(1).then(name => {
      expect(name).toBe("John Doe");
      expect(mockApi.fetchUser).toHaveBeenCalledWith(1);
    });
  });
});
```

### Asymmetric Matchers Example

```typescript
import { describe, test, expect } from "bun:test";
import { setupTestCompat, asymmetricMatchers } from "../utils/test-utils/compatibility";

setupTestCompat();

describe("DataFormatter", () => {
  test("should format data correctly", () => {
    const formatter = new DataFormatter();
    const result = formatter.format({ id: 123, name: "test", createdAt: new Date() });
    
    expect(result).toEqual({
      id: asymmetricMatchers.any(Number),
      name: asymmetricMatchers.stringContaining("test"),
      createdAt: asymmetricMatchers.any(String),
      formattedBy: asymmetricMatchers.stringContaining("DataFormatter")
    });
  });
});
```

### Module Mocking Example

```typescript
import { describe, test, expect } from "bun:test";
import { setupTestCompat, jest } from "../utils/test-utils/compatibility";

setupTestCompat();

// Mock a module
jest.mock("../services/logger", () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarning: jest.fn()
}));

// Import the module after mocking
import { logError, logInfo } from "../services/logger";

describe("ErrorHandler", () => {
  test("should log errors correctly", () => {
    const handler = new ErrorHandler();
    const error = new Error("Test error");
    
    handler.handleError(error);
    
    expect(logError).toHaveBeenCalledWith("Error occurred: Test error");
    expect(logInfo).not.toHaveBeenCalled();
  });
});
``` 
