# Test Utilities

This directory contains utilities for writing consistent, reliable tests throughout the codebase. The utilities help standardize testing patterns, reduce boilerplate, and improve test reliability.

## Table of Contents

- [Mocking Utilities](#mocking-utilities)
  - [Basic Mocking](#basic-mocking)
  - [Enhanced Mocking](#enhanced-mocking)
  - [Test Context Management](#test-context-management)
- [Dependency Utilities](#dependency-utilities)
  - [Creating Test Dependencies](#creating-test-dependencies)
  - [Domain-Specific Dependencies](#domain-specific-dependencies)
  - [Dependency Composition](#dependency-composition)
- [Test Data Generation](#test-data-generation)
  - [Domain Entity Factories](#domain-entity-factories)
  - [Test Data Arrays](#test-data-arrays)
  - [Randomization Utilities](#randomization-utilities)
- [Best Practices](#best-practices)
  - [Test Isolation](#test-isolation)
  - [Avoiding Test Pollution](#avoiding-test-pollution)
  - [Type Safety](#type-safety)

## Mocking Utilities

### Basic Mocking

```typescript
import { createMock, mockModule, setupTestMocks } from "../utils/test-utils";

// Set up automatic mock cleanup
setupTestMocks();

// Create a basic mock function
const mockFn = createMock();
mockFn("test");
expect(mockFn).toHaveBeenCalledWith("test");

// Create a mock with implementation
const mockGreet = createMock((name: string) => `Hello, ${name}!`);
expect(mockGreet("World")).toBe("Hello, World!");

// Mock a module
mockModule("fs", () => ({
  readFileSync: createMock(() => "file content"),
  existsSync: createMock(() => true)
}));
```

### Enhanced Mocking

```typescript
import { 
  mockFunction, 
  createPartialMock, 
  mockReadonlyProperty 
} from "../utils/test-utils";

// Create a type-safe mock function
type GreetFn = (name: string) => string;
const mockGreet = mockFunction<GreetFn>((name) => `Hello, ${name}!`);
const result = mockGreet("World"); // TypeScript knows result is string

// Create a partial mock of an interface
interface UserService {
  getUser(id: string): Promise<User | null>;
  updateUser(id: string, data: any): Promise<boolean>;
  deleteUser(id: string): Promise<boolean>;
}

// Only implement the methods you need
const mockUserService = createPartialMock<UserService>({
  getUser: async (id) => id === "123" ? { id, name: "Test User" } : null
});

// Other methods are still available and mocked
await mockUserService.updateUser("123", { name: "Updated" });
expect(mockUserService.updateUser).toHaveBeenCalledWith("123", { name: "Updated" });

// Mock readonly properties
const config = {
  get environment() { return "production"; }
};
mockReadonlyProperty(config, "environment", "test");
expect(config.environment).toBe("test");
```

### Test Context Management

```typescript
import { createTestSuite, withCleanup } from "../utils/test-utils";

// Create a test suite with cleanup management
const { beforeEachTest, afterEachTest } = createTestSuite();

describe("My Test Suite", () => {
  // Set up automatic context management
  beforeEach(beforeEachTest);
  afterEach(afterEachTest);
  
  test("resource cleanup", () => {
    const resource = acquireResource();
    
    // Register cleanup to happen automatically
    withCleanup(() => {
      releaseResource(resource);
    });
    
    // Test code that might throw
    expect(resource.getData()).toBeDefined();
  });
  // Cleanup happens automatically, even if test throws
});
```

## Dependency Utilities

### Creating Test Dependencies

```typescript
import { createTestDeps } from "../utils/test-utils";

// Create default test dependencies with all required interfaces mocked
const deps = createTestDeps();

// Use the dependencies in tests
const session = await deps.sessionDB.getSession("test-session");
const task = await deps.taskService.getTask("#123");

// Override specific methods for testing
const customDeps = createTestDeps({
  sessionDB: {
    getSession: createMock(() => Promise.resolve({
      session: "custom-session",
      taskId: "123",
      // ...other properties
    }))
  }
});
```

### Domain-Specific Dependencies

```typescript
import { 
  createTaskTestDeps,
  createSessionTestDeps,
  createGitTestDeps 
} from "../utils/test-utils";

// Create task-specific dependencies
const taskDeps = createTaskTestDeps();

// Create session-specific dependencies
const sessionDeps = createSessionTestDeps();

// Create git-specific dependencies
const gitDeps = createGitTestDeps();
```

### Dependency Composition

```typescript
import { withMockedDeps, createDeepTestDeps } from "../utils/test-utils";

// Temporarily override dependencies for a specific test
const result = withMockedDeps(
  originalDeps,
  {
    sessionDB: {
      getSession: createMock(() => Promise.resolve({ 
        session: "temp-session",
        // other properties
      }))
    }
  },
  async (mockDeps) => {
    // Use mockDeps here with the temporary override
    const session = await mockDeps.sessionDB.getSession("any");
    return session;
  }
);

// Create deeply nested dependencies with overrides
const deepDeps = createDeepTestDeps({
  sessionDB: {
    getSession: createMock(() => Promise.resolve({ name: "test-session" }))
  },
  gitService: {
    repoStatus: createMock(() => Promise.resolve({ clean: false }))
  }
});
```

## Test Data Generation

### Domain Entity Factories

```typescript
import { 
  createTaskData, 
  createSessionData, 
  createRepositoryData 
} from "../utils/test-utils";

// Create a task with default values
const defaultTask = createTaskData();

// Create a task with custom values
const customTask = createTaskData({
  id: "#042",
  title: "Custom Task",
  status: "IN-PROGRESS"
});

// Create a session record
const session = createSessionData({
  taskId: "123",
  session: "task#123"
});

// Create a repository configuration
const repo = createRepositoryData({
  type: "github",
  repoUrl: "github.com/user/repo"
});
```

### Test Data Arrays

```typescript
import { createTaskDataArray, createSessionDataArray } from "../utils/test-utils";

// Create an array of 5 tasks
const tasks = createTaskDataArray(5);

// Create 3 in-progress tasks
const inProgressTasks = createTaskDataArray(3, { 
  status: "IN-PROGRESS" 
});

// Create an array of 3 sessions
const sessions = createSessionDataArray(3);
```

### Randomization Utilities

```typescript
import { 
  createRandomId, 
  createRandomString, 
  createRandomFilePath,
  createFieldData
} from "../utils/test-utils";

// Create a random ID
const id = createRandomId(); // e.g., "test-12345"

// Create a random task ID
const taskId = createTaskId(); // e.g., "#123"

// Create a random string
const str = createRandomString(10); // 10 random characters

// Create a random file path
const path = createRandomFilePath("json"); // e.g., "src/abc123.json"

// Auto-generate appropriate test data based on field name
const user = {
  id: createFieldData("id"),
  name: createFieldData("name"),
  email: createFieldData("email"),
  createdAt: createFieldData("createdAt")
};
```

## Best Practices

### Test Isolation

- Use `createTestSuite()` and `withCleanup()` to ensure proper cleanup between tests
- Create fresh dependencies for each test with `createTestDeps()`
- Never modify global state without proper cleanup

### Avoiding Test Pollution

- Use `setupTestMocks()` to ensure automatic mock cleanup
- Register cleanup functions with `withCleanup()` for any resources created during tests
- Use `withMockedDeps()` for temporary dependency overrides

### Type Safety

- Use `mockFunction<T>()` instead of `createMock()` for better type safety
- Use `createPartialMock<T>()` to create interfaces with type-safe implementations
- Use factory functions to create properly typed test data

## Examples

See `/src/utils/test-utils/__tests__/enhanced-utils.test.ts` for comprehensive examples of how to use these utilities effectively. 
