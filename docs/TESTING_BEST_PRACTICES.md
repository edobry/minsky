# Testing Best Practices

This document outlines the recommended best practices for writing tests in the Minsky project. Following these guidelines will help ensure your tests are maintainable, reliable, and effective.

## Table of Contents

1. [Core Principles](#core-principles)
2. [Test Structure](#test-structure)
3. [Naming Conventions](#naming-conventions)
4. [Mocking Strategies](#mocking-strategies)
5. [Dependency Injection](#dependency-injection)
6. [Assertion Patterns](#assertion-patterns)
7. [Test Data Management](#test-data-management)
8. [Test Organization](#test-organization)
9. [Performance Considerations](#performance-considerations)
10. [Debugging Tests](#debugging-tests)
11. [Anti-patterns to Avoid](#anti-patterns-to-avoid)

## Core Principles

### 1. Write Tests That Matter

- Focus on testing behavior, not implementation details
- Test the public API of your modules and functions
- Prioritize tests that validate critical business logic
- Cover edge cases and error conditions thoroughly

### 2. Test in Isolation

- Each test should be independent of others
- Avoid test interdependencies
- Reset state between tests
- Mock external dependencies

### 3. Make Tests Readable

- Tests should document how code should work
- Use clear, descriptive test names
- Follow a consistent structure (Arrange-Act-Assert)
- Keep tests concise and focused

### 4. Ensure Test Reliability

- Tests should produce the same results on every run
- Avoid flaky tests that sometimes pass and sometimes fail
- Don't rely on timing, randomness, or external resources
- Use deterministic inputs and assertions

## Test Structure

Follow the Arrange-Act-Assert (AAA) pattern:

```typescript
import { describe, test, expect } from "bun:test";
import { userService } from "../services/user-service";

describe("userService.createUser", () => {
  test("should create a user with valid input", () => {
    // Arrange: Set up the test environment and inputs
    const userData = { name: "Test User", email: "test@example.com" };

    // Act: Execute the code being tested
    const newUser = userService.createUser(userData);

    // Assert: Verify the expected outcomes
    expect(newUser.id).toBeDefined();
    expect(newUser.name).toBe(userData.name);
    expect(newUser.email).toBe(userData.email);
  });
});
```

### For Asynchronous Tests

```typescript
import { describe, test, expect } from "bun:test";
import { userService } from "../services/user-service";

describe("userService.fetchUserData", () => {
  test("should fetch user data asynchronously", async () => {
    // Arrange
    const userId = "123";

    // Act
    const userData = await userService.fetchUserData(userId);

    // Assert
    expect(userData).toBeDefined();
    expect(userData.id).toBe(userId);
  });
});
```

## Naming Conventions

### Test File Names

- Test files should have the same name as the file they test with a `.test.ts` suffix:
  - `file-name.ts` → `file-name.test.ts`
- Place tests in a `__tests__` directory within the same directory as the source files:
  - `src/utils/format.ts` → `src/utils/__tests__/format.test.ts`
- For integration tests, use a dedicated `integration` directory:
  - `src/adapters/__tests__/integration/api-client.test.ts`

### Test Suite and Case Names

- Test suites should describe the component or function being tested:
  - `describe("UserService", ...)`
  - `describe("formatDate", ...)`
- Test case names should clearly describe what they're testing:
  - `test("should return formatted date in ISO format", ...)`
  - `test("should throw error when given invalid date", ...)`
- Use proper grammar and complete sentences in test names

## Mocking Strategies

### When to Use Mocks

- External dependencies (e.g., APIs, databases)
- Complex objects that are difficult to construct
- Side effects (e.g., file I/O, network requests)
- Time-dependent functionality

### When Not to Use Mocks

- Simple pure functions
- Core business logic
- Data structures
- Utility functions with no side effects

### Mocking Best Practices

1. **Mock at the right level**:

   - Prefer to mock at the dependency boundary
   - Don't mock everything by default
   - Consider using real implementations for critical logic

2. **Use the right mocking approach**:

   ```typescript
   // For function mocks
   import { createMock } from "../utils/test-utils/mocking";
   const mockFn = createMock();

   // For object mocks
   import { createMockObject } from "../utils/test-utils/mocking";
   const mockService = createMockObject(["getUser", "createUser", "deleteUser"]);

   // For partial implementations
   import { createPartialMock } from "../utils/test-utils/mocking";
   const mockService = createPartialMock({
     getUser: async (id) => (id === "valid" ? { id, name: "Test" } : null),
   });
   ```

3. **Verify mock usage**:
   ```typescript
   expect(mockFn.mock.calls.length).toBe(1);
   expect(mockFn.mock.calls[0][0]).toBe("expected argument");
   ```

## Dependency Injection

Dependency injection is the preferred approach for making code testable in Minsky.

### Factory Functions

Use factory functions to create objects with injected dependencies:

```typescript
// In source code
export function createUserService(deps) {
  return {
    getUser: async (id) => {
      try {
        return await deps.userRepository.findById(id);
      } catch (error) {
        deps.logger.error(`Error fetching user ${id}: ${error.message}`);
        throw error;
      }
    },
  };
}

// In tests
import { createMock } from "../utils/test-utils/mocking";
import { createUserService } from "../services/user-service";

test("getUser should handle repository errors", async () => {
  // Create mocks
  const error = new Error("DB connection failed");
  const mockFindById = createMock(() => Promise.reject(error));
  const mockLogger = { error: createMock() };

  // Create service with mocked dependencies
  const userService = createUserService({
    userRepository: { findById: mockFindById },
    logger: mockLogger,
  });

  // Test
  try {
    await userService.getUser("123");
    expect(false).toBe(true); // Should not reach here
  } catch (e) {
    expect(e).toBe(error);
    expect(mockLogger.error).toHaveBeenCalledWith("Error fetching user 123: DB connection failed");
  }
});
```

### Dependency Container

For more complex scenarios, use a dependency container:

```typescript
// In tests
import { createTestDeps } from "../utils/test-utils/dependencies";

test("createTask should call the right dependencies", async () => {
  // Create test dependencies
  const deps = createTestDeps({
    taskService: createPartialMock({
      createTask: createMock(() => Promise.resolve({ id: "new-task" })),
    }),
  });

  // Use deps in test
  const result = await someFunction(deps);
  expect(deps.taskService.createTask).toHaveBeenCalled();
});
```

## Assertion Patterns

### Basic Assertions

```typescript
// Value equality
expect(result).toBe(5); // Strict equality (===)
expect(result).toEqual({ id: 1 }); // Deep equality for objects

// Truthiness
expect(value).toBeTruthy(); // Tests if value is truthy
expect(value).toBeFalsy(); // Tests if value is falsy
expect(value).toBeNull(); // Tests if value is null
expect(value).toBeUndefined(); // Tests if value is undefined
expect(value).toBeDefined(); // Tests if value is defined

// Numbers
expect(value).toBeGreaterThan(3);
expect(value).toBeLessThanOrEqual(10);

// Strings
expect(str).toContain("substring");
expect(str).toMatch(/pattern/);

// Arrays
expect(array).toContain("item");
expect(array).toHaveLength(3);

// Objects
expect(object).toHaveProperty("property");
expect(object.property).toBeDefined();
```

### Error Assertions

```typescript
// Test if a function throws
test("should throw error for invalid input", () => {
  expect(() => {
    validateInput("");
  }).toThrow();

  expect(() => {
    validateInput("");
  }).toThrow("Input cannot be empty");
});

// Test async errors
test("should reject with error for invalid user", async () => {
  try {
    await userService.getUser("-1");
    // If we reach here, the test should fail
    expect(true).toBe(false);
  } catch (error) {
    expect(error.message).toBe("Invalid user ID");
  }
});
```

### Complex Object Assertions

When testing complex objects, focus on the relevant properties:

```typescript
test("createUser should return a valid user object", () => {
  const result = userService.createUser({ name: "Test" });

  // Only test what matters for this test
  expect(result).toEqual({
    id: expect.any(String),
    name: "Test",
    createdAt: expect.any(Date),
  });
});
```

## Test Data Management

### Test Data Creation

Use factory functions to create test data:

```typescript
// In test-utils/factories.ts
export function createTestUser(overrides = {}) {
  return {
    id: "test-id",
    name: "Test User",
    email: "test@example.com",
    roles: ["user"],
    createdAt: new Date("2023-01-01"),
    ...overrides,
  };
}

// In tests
import { createTestUser } from "../test-utils/factories";

test("should update user email", () => {
  const user = createTestUser();
  const updatedEmail = "new@example.com";

  const result = userService.updateEmail(user, updatedEmail);

  expect(result.email).toBe(updatedEmail);
});
```

### Managing Test State

Use `beforeEach` and `afterEach` to manage test state:

```typescript
describe("Database operations", () => {
  let db;

  beforeEach(async () => {
    db = createInMemoryDatabase();
    await db.connect();
  });

  afterEach(async () => {
    await db.clear();
    await db.disconnect();
  });

  test("should store data correctly", async () => {
    await db.insert({ key: "test", value: "data" });
    const result = await db.get("test");
    expect(result).toBe("data");
  });
});
```

## Test Organization

### Grouping Related Tests

Use nested `describe` blocks to group related tests:

```typescript
describe("UserService", () => {
  describe("getUser", () => {
    test("should return user by ID", () => {
      /* ... */
    });
    test("should return null for invalid ID", () => {
      /* ... */
    });
    test("should throw error for unauthorized access", () => {
      /* ... */
    });
  });

  describe("updateUser", () => {
    test("should update user properties", () => {
      /* ... */
    });
    test("should reject invalid properties", () => {
      /* ... */
    });
  });
});
```

### Using Test Context

Use test context for shared resources:

```typescript
import { describe, test } from "bun:test";

interface TestContext {
  user: User;
  service: UserService;
}

const testWithUser = test.with({
  beforeEach(ctx: TestContext) {
    ctx.user = createTestUser();
    ctx.service = createUserService({
      /* deps */
    });
  },
});

testWithUser("should update user profile", ({ user, service }) => {
  const result = service.updateProfile(user, { name: "New Name" });
  expect(result.name).toBe("New Name");
});
```

## Performance Considerations

- Keep tests fast by minimizing external dependencies
- Use in-memory databases for data layer tests
- Mock expensive operations
- Group slow tests and run them separately when needed
- Consider test parallelization for independent tests

## Debugging Tests

### Effective Debugging Techniques

- Use console output judiciously

  ```typescript
  test("complex operation", () => {
    const result = complexOperation();
    console.log("Result:", result); // Remove before committing
    expect(result).toEqual(expected);
  });
  ```

- Debug step-by-step

  ```typescript
  test("multi-step process", () => {
    // Step 1
    const step1Result = step1();
    expect(step1Result).toBeDefined();

    // Step 2
    const step2Result = step2(step1Result);
    expect(step2Result).toEqual(expected);
  });
  ```

- Isolate failing tests
  ```typescript
  test.only("focus on this test", () => {
    // Only this test will run
  });
  ```

## Anti-patterns to Avoid

### 1. Testing Implementation Details

**Bad:**

```typescript
test("internal method _processData should work", () => {
  // Testing private implementation details
  const result = service._processData(input);
  expect(result).toBe(expected);
});
```

**Good:**

```typescript
test("processInput should handle valid data", () => {
  // Testing the public API
  const result = service.processInput(input);
  expect(result).toBe(expected);
});
```

### 2. Overlapping Tests

**Bad:**

```typescript
test("should create user", () => {
  const user = service.createUser(data);
  expect(user.id).toBeDefined();
  expect(user.name).toBe(data.name);
  expect(user.email).toBe(data.email);
  expect(user.roles).toContain("user");
  expect(user.createdAt).toBeInstanceOf(Date);
});
```

**Good:**

```typescript
test("should create user with correct basic properties", () => {
  const user = service.createUser(data);
  expect(user.id).toBeDefined();
  expect(user.name).toBe(data.name);
  expect(user.email).toBe(data.email);
});

test("should assign default user role to new users", () => {
  const user = service.createUser(data);
  expect(user.roles).toContain("user");
});
```

### 3. Non-Isolated Tests

**Bad:**

```typescript
// Test depends on global state
let sharedUser;

test("first test creates user", () => {
  sharedUser = service.createUser(data);
  expect(sharedUser.id).toBeDefined();
});

test("second test uses that user", () => {
  // This test depends on the first test
  const result = service.updateUser(sharedUser.id, { active: true });
  expect(result.active).toBe(true);
});
```

**Good:**

```typescript
test("creating and then updating a user", () => {
  // Self-contained test
  const user = service.createUser(data);
  expect(user.id).toBeDefined();

  const updated = service.updateUser(user.id, { active: true });
  expect(updated.active).toBe(true);
});
```

### 4. Excessive Mocking

**Bad:**

```typescript
test("user validation", () => {
  // Mocking everything, including simple validation logic
  const validateEmail = jest.fn(() => true);
  const validateName = jest.fn(() => true);

  const service = createService({ validateEmail, validateName });
  service.validateUser({ name: "Test", email: "test@example.com" });

  expect(validateEmail).toHaveBeenCalled();
  expect(validateName).toHaveBeenCalled();
});
```

**Good:**

```typescript
test("user validation", () => {
  // Use real validation logic, mock only external dependencies
  const emailService = { sendValidationEmail: createMock() };

  const service = createService({ emailService });
  const result = service.validateUser({ name: "Test", email: "test@example.com" });

  expect(result.valid).toBe(true);
  expect(emailService.sendValidationEmail).toHaveBeenCalled();
});
```
