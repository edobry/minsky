# Mocking Utilities

This document provides detailed documentation of the mocking utilities available in the Minsky codebase for writing effective tests.

## Table of Contents

1. [Introduction](#introduction)
2. [Basic Mocking](#basic-mocking)
   - [createMock](#createmock)
   - [mockFunction](#mockfunction)
   - [setupTestMocks](#setuptestmocks)
3. [Module Mocking](#module-mocking)
   - [mockModule](#mockmodule)
4. [Enhanced Mocking](#enhanced-mocking)
   - [createMockObject](#createmockobject)
   - [createPartialMock](#createpartialmock)
   - [mockReadonlyProperty](#mockreadonlyproperty)
5. [Mock Filesystems](#mock-filesystems)
   - [createMockFileSystem](#createmockfilesystem)
6. [Dependency Utilities](#dependency-utilities)
   - [createTestDeps](#createtestdeps)
   - [createTaskTestDeps](#createtasktestdeps)
7. [Compatibility Layer](#compatibility-layer)
8. [Best Practices](#best-practices)

## Introduction

Minsky provides a comprehensive set of mocking utilities to simplify test writing and improve test reliability. These utilities help with:

- Creating mock functions with proper tracking and type safety
- Mocking entire modules
- Creating mock objects and services
- Setting up test dependencies
- Working with filesystem operations in tests

## Basic Mocking

### createMock

`createMock` is the core mocking utility that creates a function-like object that tracks how it was called.

**Import:**
```typescript
import { createMock } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Create a basic mock
const mockFn = createMock();
mockFn("test");
expect(mockFn.mock.calls.length).toBe(1);

// Create a mock with implementation
const mockGreet = createMock((name: string) => `Hello, ${name}!`);
expect(mockGreet("World")).toBe("Hello, World!");
```

**Properties:**
- `mock.calls`: Array of arguments passed to each call
- `mock.calls.length`: Number of times the mock was called

### mockFunction

`mockFunction` is a type-safe version of `createMock` that provides better TypeScript support.

**Import:**
```typescript
import { mockFunction } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Define a function type
type GreetFn = (name: string) => string;

// Create a type-safe mock
const mockGreet = mockFunction<GreetFn>((name) => `Hello, ${name}!`);
const result = mockGreet("World"); // TypeScript knows result is string
```

### setupTestMocks

`setupTestMocks` ensures that mocks are properly cleaned up after each test to prevent test pollution.

**Import:**
```typescript
import { setupTestMocks } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// At the top level of your test file
setupTestMocks();

describe("My tests", () => {
  test("using mocks", () => {
    const mockFn = createMock();
    // Use the mock
  });
  
  // Mocks are automatically cleaned up between tests
  test("using more mocks", () => {
    const anotherMock = createMock();
    // Mock state is clean, not affected by previous test
  });
});
```

## Module Mocking

### mockModule

`mockModule` allows you to mock an entire module with a custom implementation.

**Import:**
```typescript
import { mockModule } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Mock a module
mockModule("../path/to/module", () => ({
  someFunction: createMock(() => "mocked result"),
  someValue: "mocked value"
}));

// Later imports will use the mocked implementation
const { someFunction } = await import("../path/to/module");
expect(someFunction()).toBe("mocked result");
```

**Note:** For module mocking to work properly, call `mockModule` before importing the module you want to mock.

## Enhanced Mocking

### createMockObject

`createMockObject` creates an object with all specified methods mocked.

**Import:**
```typescript
import { createMockObject } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Create a mock service with multiple methods
const userService = createMockObject([
  "getUser",
  "updateUser",
  "deleteUser"
]);

// Configure specific behavior
userService.getUser.mockImplementation((id) => ({ id, name: "Test User" }));

// Use in tests
const user = userService.getUser("123");
expect(user).toEqual({ id: "123", name: "Test User" });
expect(userService.getUser).toHaveBeenCalledWith("123");
```

### createPartialMock

`createPartialMock` creates a mock object that implements an interface with custom implementations for specific methods.

**Import:**
```typescript
import { createPartialMock } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Define an interface
interface UserService {
  getUser(id: string): Promise<User | null>;
  updateUser(id: string, data: any): Promise<boolean>;
  deleteUser(id: string): Promise<boolean>;
}

// Create a partial mock with only some methods implemented
const mockUserService = createPartialMock<UserService>({
  getUser: async (id) => id === "123" ? { id, name: "Test User" } : null
});

// Other methods are automatically mocked
await mockUserService.updateUser("123", { name: "Updated" });
expect(mockUserService.updateUser).toHaveBeenCalledWith("123", { name: "Updated" });
```

### mockReadonlyProperty

`mockReadonlyProperty` allows you to mock a readonly property on an object.

**Import:**
```typescript
import { mockReadonlyProperty } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Object with readonly property
const config = {
  get environment() { return "production"; }
};

// Mock the property
mockReadonlyProperty(config, "environment", "test");

// Verification
expect(config.environment).toBe("test");
```

## Mock Filesystems

### createMockFileSystem

`createMockFileSystem` creates a mock filesystem that can be used in tests without touching the real filesystem.

**Import:**
```typescript
import { createMockFileSystem } from "../utils/test-utils/mocking";
```

**Usage:**
```typescript
// Create a mock filesystem with initial files
const mockFS = createMockFileSystem({
  "/path/to/file.txt": "Initial content",
  "/path/to/config.json": JSON.stringify({ setting: true })
});

// Mock the fs module
mockModule("fs", () => ({
  existsSync: mockFS.existsSync,
  readFileSync: mockFS.readFileSync,
  writeFileSync: mockFS.writeFileSync,
  mkdirSync: mockFS.mkdirSync,
  unlink: mockFS.unlink
}));

// Now you can use the fs module in your tests
const fs = require("fs");
expect(fs.existsSync("/path/to/file.txt")).toBe(true);
expect(fs.readFileSync("/path/to/file.txt", "utf8")).toBe("Initial content");

// Create new files
fs.writeFileSync("/path/to/new-file.txt", "New content");
expect(fs.existsSync("/path/to/new-file.txt")).toBe(true);
```

## Dependency Utilities

### createTestDeps

`createTestDeps` creates mock implementations of common domain dependencies for testing.

**Import:**
```typescript
import { createTestDeps } from "../utils/test-utils/dependencies";
```

**Usage:**
```typescript
// Create mock dependencies
const deps = createTestDeps({
  // Override specific implementations
  gitService: createPartialMock({
    createPR: createMock(() => Promise.resolve({ success: true, url: "https://github.com/org/repo/pull/123" }))
  })
});

// Use in tests
const result = await someFunction(deps);
expect(deps.gitService.createPR).toHaveBeenCalled();
```

**Available Dependencies:**
- `sessionDB`: Mock implementation of `SessionProviderInterface`
- `gitService`: Mock implementation of `GitServiceInterface`
- `taskService`: Mock implementation of `TaskServiceInterface`
- `workspaceUtils`: Mock implementation of `WorkspaceUtilsInterface`

### createTaskTestDeps

`createTaskTestDeps` creates task-specific test dependencies.

**Import:**
```typescript
import { createTaskTestDeps } from "../utils/test-utils/dependencies";
```

**Usage:**
```typescript
// Create task-specific dependencies
const taskDeps = createTaskTestDeps({
  taskService: createPartialMock({
    getTask: createMock(() => Promise.resolve({ id: "#123", title: "Test Task", status: "TODO" }))
  })
});

// Use in tests
const result = await taskHandlerFunction(taskDeps);
expect(taskDeps.taskService.getTask).toHaveBeenCalled();
```

## Compatibility Layer

For tests that use Jest/Vitest patterns, see the [Compatibility Layer Documentation](COMPATIBILITY_LAYER.md).

## Best Practices

### Test Isolation

Always ensure your tests are isolated:

```typescript
// At the top level of your test file
import { setupTestMocks } from "../utils/test-utils/mocking";
setupTestMocks();
```

### Avoiding Test Pollution

Reset mocks between tests if they're shared:

```typescript
// Reset a mock between tests
beforeEach(() => {
  mockFunction.mockReset();
});
```

### Type Safety

Use typed mocks for better IDE support and error checking:

```typescript
// Prefer this:
type UserServiceFn = (id: string) => Promise<User>;
const mockGetUser = mockFunction<UserServiceFn>();

// Over this:
const mockGetUser = createMock();
```

### Module Mocking Order

When mocking modules, always mock before importing:

```typescript
// Correct order
mockModule("../path/to/module", () => ({ ... }));
import { something } from "../path/to/module";

// Incorrect order - won't work
import { something } from "../path/to/module";
mockModule("../path/to/module", () => ({ ... }));
```

### Dependency Injection

Prefer dependency injection for easier testing:

```typescript
// Easier to test
function createService(deps) {
  return {
    doSomething: () => deps.otherService.callMethod()
  };
}

// Test with
const mockDeps = { otherService: { callMethod: createMock() } };
const service = createService(mockDeps);
``` 
