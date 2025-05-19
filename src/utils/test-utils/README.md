# Test Utilities

This directory contains utilities for writing consistent, reliable tests throughout the codebase. The utilities help standardize testing patterns, reduce boilerplate, and improve test reliability.

## Table of Contents

- [Mocking Utilities](#mocking-utilities)
  - [Basic Usage](#basic-usage)
  - [API Reference](#api-reference)
  - [Usage Examples](#usage-examples)
- [Test Pollution and How to Avoid It](#test-pollution-and-how-to-avoid-it)
  - [What is Test Pollution?](#what-is-test-pollution)
  - [Common Causes](#common-causes)
  - [Best Practices](#best-practices)
- [Additional Utilities](#additional-utilities)

## Mocking Utilities

The `mocking.ts` module provides centralized utilities for creating mocks in tests. These utilities encapsulate Bun's testing mocking patterns for easier and consistent usage.

### Basic Usage

```typescript
import { 
  createMock, 
  mockModule, 
  setupTestMocks 
} from "../utils/test-utils";

// Set up automatic mock cleanup
setupTestMocks();

describe("My Test Suite", () => {
  it("should mock a function", () => {
    const mockFn = createMock(() => "mock result");
    expect(mockFn()).toBe("mock result");
    expect(mockFn).toHaveBeenCalled();
  });

  it("should mock a module", async () => {
    mockModule("fs", () => ({
      readFileSync: createMock(() => "file content"),
      existsSync: createMock(() => true)
    }));

    const fs = await import("fs");
    expect(fs.readFileSync("any-path")).toBe("file content");
  });
});
```

### API Reference

#### `createMock(implementation?)`

Creates a mock function with type safety and call tracking.

```typescript
// Basic usage
const mockFn = createMock();

// With implementation
const mockGreet = createMock((name: string) => `Hello, ${name}!`);

// With call tracking
mockFn("test");
expect(mockFn).toHaveBeenCalledWith("test");
```

#### `mockModule(modulePath, factory)`

Mocks a module with custom implementation.

```typescript
mockModule("path/to/module", () => ({
  someFunction: createMock(() => "mocked result"),
  someValue: "mocked value"
}));

// Later imports will use the mock
const { someFunction } = await import("path/to/module");
```

#### `setupTestMocks()`

Sets up automatic cleanup of mocks after each test.

```typescript
// Call this at the top level of your test file
setupTestMocks();
```

#### `createMockObject(methods, implementations?)`

Creates an object with all specified methods mocked.

```typescript
const userService = createMockObject([
  "getUser",
  "updateUser",
  "deleteUser"
]);

// With implementations
const userService = createMockObject(
  ["getUser", "updateUser", "deleteUser"],
  {
    getUser: (id) => ({ id, name: "Test" })
  }
);
```

#### `createMockExecSync(commandResponses)`

Creates a mock for child_process.execSync that responds based on command patterns.

```typescript
mockModule("child_process", () => ({
  execSync: createMockExecSync({
    "ls": "file1.txt\nfile2.txt",
    "git status": "On branch main"
  })
}));
```

#### `createMockFileSystem(initialFiles?)`

Creates a mock filesystem with basic operations.

```typescript
const mockFS = createMockFileSystem({
  "/path/to/file.txt": "Initial content"
});

mockModule("fs", () => ({
  existsSync: mockFS.existsSync,
  readFileSync: mockFS.readFileSync,
  // ...other fs functions
}));
```

### Usage Examples

#### Mocking Repository Operations

```typescript
import { createMock, mockModule, setupTestMocks } from "../utils/test-utils";

setupTestMocks();

describe("Repository Operations", () => {
  it("should commit changes", async () => {
    // Mock child_process.execSync
    mockModule("child_process", () => ({
      execSync: createMock((cmd) => {
        if (cmd.includes("git commit")) return "1 file changed";
        return "";
      })
    }));

    const { commitChanges } = await import("../src/repository");
    const result = await commitChanges("test commit");
    
    expect(result).toContain("1 file changed");
  });
});
```

#### Mocking File System Operations

```typescript
import { createMockFileSystem, mockModule, setupTestMocks } from "../utils/test-utils";

setupTestMocks();

describe("Config Manager", () => {
  it("should read config from file", async () => {
    const mockFS = createMockFileSystem({
      "/app/config.json": JSON.stringify({ apiKey: "test-key" })
    });
    
    mockModule("fs", () => ({
      existsSync: mockFS.existsSync,
      readFileSync: mockFS.readFileSync,
      writeFileSync: mockFS.writeFileSync
    }));

    const { ConfigManager } = await import("../src/config");
    const config = new ConfigManager("/app/config.json");
    
    expect(config.get("apiKey")).toBe("test-key");
  });
});
```

## Test Pollution and How to Avoid It

### What is Test Pollution?

Test pollution occurs when state changes from one test affect the behavior of subsequent tests. This leads to:

- Flaky tests that pass in isolation but fail when run as part of a suite
- Tests that pass/fail depending on execution order
- Difficult-to-debug test failures
- False positives and false negatives

In Bun/Jest testing, module mocking is a common source of test pollution since mocked modules may persist between tests if not properly reset.

### Common Causes

1. **Module Mocking Without Cleanup**
   
   When using `mock.module()` without properly restoring the original module.

2. **Shared Mutable State**
   
   When tests share references to the same mutable objects.

3. **Global State Modification**
   
   When tests modify global objects like `global`, `process`, or built-in prototypes.

4. **Persistence of Mocks Across Tests**
   
   When mock implementations set in one test leak into another.

### Best Practices

#### 1. Use `setupTestMocks()`

Always call `setupTestMocks()` at the top level of your test file. This ensures all mocks are automatically restored after each test.

```typescript
import { setupTestMocks } from "../utils/test-utils";

// This ensures mocks are restored after each test
setupTestMocks();
```

#### 2. Isolate Tests

Each test should be completely independent. Avoid shared state between tests.

```typescript
// AVOID: Shared mock object across tests
const mockFS = createMockFileSystem();

// BETTER: Create fresh mocks in each test
it("test 1", () => {
  const mockFS = createMockFileSystem();
  // Use mockFS
});

it("test 2", () => {
  const mockFS = createMockFileSystem();
  // Use mockFS with clean state
});
```

#### 3. Scope Mocks Appropriately

Define mocks at the narrowest possible scope:

```typescript
// AVOID: Mocking at describe level unless needed
describe("Suite", () => {
  beforeEach(() => {
    mockModule("fs", () => ({ /* ... */ }));
  });
  
  // All tests will use this mock
});

// BETTER: Mock only in tests that need it
describe("Suite", () => {
  it("test that needs mock", () => {
    mockModule("fs", () => ({ /* ... */ }));
    // Only this test uses the mock
  });
});
```

#### 4. Reset State After Tests

Explicitly reset or clean up any global state modifications.

```typescript
describe("Environment Tests", () => {
  const originalEnv = { ...process.env };
  
  afterEach(() => {
    // Reset to original state
    process.env = { ...originalEnv };
  });
  
  it("should test with custom env", () => {
    process.env.TEST_VAR = "test";
    // Test with modified environment
  });
});
```

#### 5. Use Isolated File System Paths

When testing file operations, use unique paths for each test.

```typescript
import { randomUUID } from "crypto";

it("should write to file", () => {
  // Use a unique path for this test
  const testPath = `/tmp/test-${randomUUID()}`;
  // Test file operations at testPath
});
```

#### 6. Prefer Shallow Mocking

Mock only what you need, not entire modules if possible.

```typescript
// AVOID: Mocking entire fs module when only need one function
mockModule("fs", () => ({ /* everything */ }));

// BETTER: Mock specific function
const originalReadFile = fs.readFile;
fs.readFile = createMock();
// After test: fs.readFile = originalReadFile;
```

#### 7. Be Aware of Dynamic Imports

Be especially careful with dynamic imports and ensure they're capturing mocked modules:

```typescript
// This pattern is prone to test pollution:
mockModule("module", () => ({ /* mock */ }));
import { func } from "module"; // This might not see the mock!

// BETTER: Use dynamic imports after mocking
mockModule("module", () => ({ /* mock */ }));
const { func } = await import("module");
```

## Additional Utilities

Besides mocking utilities, this directory contains other testing helpers:

- **Console output capturing**: `setupConsoleSpy()`
- **Temporary directory management**: `createTempTestDir()`
- **Date and time mocking**: `mockDateFunctions()`
- **Test environment setup**: `setupTestEnvironment()`

See each utility's JSDoc comments for detailed usage instructions. 
