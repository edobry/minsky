# DI Testing Patterns Quick Guide

## Which Pattern Should I Use?

### 🎯 Quick Decision Tree

**Testing a domain function with complex dependencies?**
→ Use **Manual DI Pattern** (Pattern 1)

**Testing an adapter, command, or integration point?**
→ Use **Spy Pattern** (Pattern 2)

**Testing utilities or simple functions?**
→ Use **Utility Helper Pattern** (Pattern 3)

---

## Pattern 1: Manual DI (Domain Functions)

**When to use:**
- Testing domain functions that accept dependencies as parameters
- Need precise control over dependency behavior
- Testing complex business logic with multiple interactions

**Example:**
```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking.ts";

setupTestMocks();

describe("updateSessionFromParams", () => {
  let mockGitService: any;
  let mockSessionProvider: any;

  beforeEach(() => {
    mockGitService = {
      stashChanges: createMock(() => Promise.resolve()),
      pullLatest: createMock(() => Promise.resolve()),
      mergeBranch: createMock(() => Promise.resolve({ conflicts: false })),
    };

    mockSessionProvider = {
      getSession: createMock(() => Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        // ... other properties
      })),
    };
  });

  test("should update session successfully", async () => {
    const result = await updateSessionFromParams(
      { name: "test-session", force: false },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
      }
    );

    expect(result.session).toBe("test-session");
    expect(mockGitService.stashChanges).toHaveBeenCalled();
  });
});
```

**Pros:**
- Explicit dependency control
- Type-safe
- Easy to customize per test
- Clear test intentions

**Cons:**
- More boilerplate
- Need to manually create all dependencies

---

## Pattern 2: Spy Pattern (Adapters & Integration)

**When to use:**
- Testing adapters, commands, or CLI handlers
- Need to verify calls to existing modules
- Testing integration between layers

**Example:**
```typescript
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as tasksDomain from "../../../../domain/tasks.js";

describe("Tasks Command Handler", () => {
  let getTaskStatusSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getTaskStatusSpy = spyOn(tasksDomain, "getTaskStatusFromParams")
      .mockImplementation(() => Promise.resolve("TODO"));
  });

  afterEach(() => {
    mock.restore();
  });

  test("should call domain function with correct params", async () => {
    const command = sharedCommandRegistry.getCommand("tasks.status.get");
    const result = await command!.execute({ taskId: "123" });

    expect(getTaskStatusSpy).toHaveBeenCalledWith({
      taskId: "123",
      repo: undefined,
      session: undefined,
    });
    expect(result).toBe("TODO");
  });
});
```

**Pros:**
- Simple setup
- Good for integration testing
- Tests real module interactions

**Cons:**
- Less control over dependencies
- Requires understanding module structure

---

## Pattern 3: Utility Helpers (Simple Tests)

**When to use:**
- Testing utilities or simple functions
- Want consistent, reusable test setups
- Need quick, standard dependency configurations

**Example:**
```typescript
import { describe, test, expect } from "bun:test";
import { createTestDeps, createTaskData, withMockedDeps } from "../../utils/test-utils";

describe("Utility Function Tests", () => {
  test("should work with default dependencies", async () => {
    const deps = createTestDeps();
    
    // Test your function with standard dependencies
    const result = await myUtilityFunction(deps);
    expect(result).toBeDefined();
  });

  test("should work with specific overrides", async () => {
    const result = withMockedDeps(
      createTestDeps(),
      {
        taskService: {
          getTask: createMock(() => Promise.resolve(createTaskData({ status: "DONE" })))
        }
      },
      async (deps) => {
        return await myUtilityFunction(deps);
      }
    );

    expect(result).toBeDefined();
  });
});
```

**Pros:**
- Minimal boilerplate
- Consistent patterns
- Good for simple tests

**Cons:**
- Less control over specific behaviors
- May be overkill for very simple functions

---

## Common Scenarios & Recipes

### ✅ Testing Domain Logic (Use Pattern 1)
```typescript
// Domain functions that accept dependencies
await updateSessionFromParams(params, deps);
await listTasksFromParams(params, deps);
await getTaskFromParams(params, deps);
```

### ✅ Testing Command Handlers (Use Pattern 2)
```typescript
// CLI adapters, MCP handlers, shared commands
const command = registry.getCommand("tasks.list");
await command.execute(params, context);
```

### ✅ Testing Utilities (Use Pattern 3)
```typescript
// Utility functions, helpers, simple business logic
const result = await utilityFunction(deps);
```

### ✅ Testing Error Handling (Any Pattern)
```typescript
// Use custom assertions for clean error testing
import { expectToBeInstanceOf } from "../../utils/test-utils/assertions.ts";

try {
  await functionThatShouldThrow();
  throw new Error("Should have thrown");
} catch (error) {
  expectToBeInstanceOf(error, ValidationError);
}
```

---

## Migration Examples

### From Jest/Vitest to Manual DI
**Before (Jest):**
```typescript
jest.mock("../domain/git");
const mockGitService = require("../domain/git") as jest.Mocked<typeof GitService>;
```

**After (Manual DI):**
```typescript
const mockGitService = {
  stashChanges: createMock(() => Promise.resolve()),
  pullLatest: createMock(() => Promise.resolve()),
};
```

### From Complex Mocking to Utility Helpers
**Before (Complex):**
```typescript
const mockTaskService = {
  getTask: createMock(() => Promise.resolve({
    id: "#123",
    title: "Test Task",
    status: "TODO",
    description: "Test description",
    worklog: []
  }))
};
```

**After (Utility Helper):**
```typescript
const deps = createTestDeps({
  taskService: {
    getTask: createMock(() => Promise.resolve(createTaskData({ status: "TODO" })))
  }
});
```

---

## Best Practices

1. **Start simple** - Use Pattern 3 for basic tests, upgrade to Pattern 1 only when needed
2. **Be consistent** - Use the same pattern for similar types of tests in your file
3. **Use custom assertions** - `expectToBeInstanceOf`, `expectToHaveBeenCalled` for cleaner tests
4. **Clean up properly** - Always use `setupTestMocks()` or proper afterEach cleanup
5. **Keep it readable** - Choose the pattern that makes your test intention clearest 
