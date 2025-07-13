# Test Architecture Guide

> **Note:** This guide documents the new test architecture implemented in Task #270 to eliminate confusion between domain function tests and adapter tests.

## Overview

This guide explains our test organization philosophy and how to write tests for different layers of the Minsky architecture. The key principle is that **tests are organized by architectural layer, not by interface**.

## Test Organization Philosophy

### Problem We Solved

Previously, tests were organized by interface (CLI, MCP) but were actually testing domain logic, creating confusion:

```
❌ WRONG: "Integration tests test adapter layers"
✅ CORRECT: "Integration tests test domain function workflows"
```

### Solution: Layer-Based Organization

Tests are now organized by the architectural layer they test:

```
__tests__/
├── domain/
│   ├── commands/         # *FromParams function tests (business logic)
│   └── services/         # Domain service tests (data operations)
├── adapters/             # Interface-specific tests
│   ├── cli/              # CLI-specific formatting, parsing
│   └── mcp/              # MCP-specific protocol handling
└── utils/                # Utility function tests
```

## Test Categories

### 1. Domain Command Tests

**Purpose:** Test `*FromParams` functions (business logic layer)  
**Location:** `__tests__/domain/commands/`  
**Naming:** `[module].commands.test.ts`

These test the interface-agnostic command functions that:
- Validate parameters
- Orchestrate domain services  
- Implement business rules
- Handle error cases

**Example:**
```typescript
// __tests__/domain/commands/tasks.commands.test.ts
describe("Task Domain Commands", () => {
  test("getTaskFromParams validates and retrieves task", async () => {
    // Test business logic, validation, service orchestration
    const params = { id: "123" };
    const result = await getTaskFromParams(params);
    expect(result.id).toBe("123");
  });
});
```

### 2. Domain Service Tests

**Purpose:** Test core domain services (data operation layer)  
**Location:** `domain/__tests__/` (existing location)  
**Naming:** `[service].service.test.ts`

These test the data operations and core business logic:
- Data retrieval and storage
- Business rule enforcement
- Service method functionality

**Example:**
```typescript
// domain/__tests__/taskService.test.ts
describe("TaskService", () => {
  test("getTask retrieves task from backend", async () => {
    // Test data operations
    const task = await taskService.getTask("123");
    expect(task).toBeDefined();
  });
});
```

### 3. Adapter Tests

**Purpose:** Test interface-specific concerns only  
**Location:** `__tests__/adapters/`  
**Naming:** `[interface].[module].adapter.test.ts`

These test interface-specific logic:
- Command registration
- Format conversion
- Protocol handling
- UI concerns

**Example:**
```typescript
// __tests__/adapters/shared.tasks.adapter.test.ts
describe("Shared Tasks Commands", () => {
  test("registers correct number of commands", () => {
    // Test command registration mechanics
    registerTasksCommands();
    expect(sharedCommandRegistry.commands.size).toBe(7);
  });
});
```

## Interface-Agnostic Command Architecture

Understanding this architecture is crucial for writing correct tests:

```
CLI Adapter  ┐
            ├──► *FromParams Functions ──► Domain Services
MCP Adapter  ┘    (Domain Layer)              (Data Layer)
(Interface Layer)
```

- **Interface Layer:** CLI, MCP adapters handle UI/protocol concerns
- **Domain Layer:** `*FromParams` functions handle business logic
- **Data Layer:** Domain services handle data operations

## Test File Examples

### Domain Command Tests
- `tasks.commands.test.ts` - Tests `getTaskFromParams`, `setTaskStatusFromParams`
- `session.commands.test.ts` - Tests `getSessionFromParams`, `startSessionFromParams`
- `git.commands.test.ts` - Tests `commitChangesFromParams`, `pushFromParams`

### Domain Service Tests
- `taskService.service.test.ts` - Tests `TaskService.getTask`, etc.
- `sessionDB.service.test.ts` - Tests `SessionDB` methods

### Adapter Tests
- `shared.tasks.adapter.test.ts` - Tests task command registration
- `cli.tasks.adapter.test.ts` - Tests CLI-specific formatting
- `mcp.tasks.adapter.test.ts` - Tests MCP protocol compliance

## Best Practices

### For Domain Command Tests
1. **Test business logic, not implementation details**
2. **Mock domain services, not external dependencies**
3. **Focus on parameter validation and workflow orchestration**
4. **Test both success and error cases**

### For Domain Service Tests
1. **Test data operations and persistence**
2. **Mock external dependencies (file system, network)**
3. **Test business rule enforcement**
4. **Verify service contracts**

### For Adapter Tests
1. **Test interface-specific concerns only**
2. **Mock domain functions completely**
3. **Focus on formatting, parsing, protocol compliance**
4. **Keep tests minimal and focused**

## Common Pitfalls to Avoid

### ❌ Wrong: Testing Domain Logic in Adapter Tests
```typescript
// DON'T do this in adapter tests
test("command gets task correctly", async () => {
  // This tests domain logic, not adapter logic
  const result = await getTaskFromParams({ id: "123" });
  expect(result.title).toBe("Test Task");
});
```

### ✅ Right: Testing Command Registration in Adapter Tests
```typescript
// DO this in adapter tests
test("command registers correctly", () => {
  // This tests adapter mechanics
  registerTasksCommands();
  expect(sharedCommandRegistry.has("tasks:get")).toBe(true);
});
```

### ❌ Wrong: Testing Interface Details in Domain Tests
```typescript
// DON'T do this in domain tests
test("CLI output format is correct", () => {
  // This tests interface details, not domain logic
  const output = formatTaskForCLI(task);
  expect(output).toContain("Task #123");
});
```

### ✅ Right: Testing Business Logic in Domain Tests
```typescript
// DO this in domain tests
test("validates task ID parameter", async () => {
  // This tests domain validation logic
  await expect(getTaskFromParams({}))
    .rejects.toThrow("Task ID is required");
});
```

## How to Choose Test Category

### Decision Tree

1. **Are you testing a `*FromParams` function?**
   → Domain Command Test (`__tests__/domain/commands/`)

2. **Are you testing a domain service method?**
   → Domain Service Test (`domain/__tests__/`)

3. **Are you testing command registration or interface formatting?**
   → Adapter Test (`__tests__/adapters/`)

4. **Are you testing a utility function?**
   → Utility Test (`__tests__/utils/` or existing location)

### When in Doubt

Ask yourself: **"What layer of the architecture am I testing?"**
- Business logic → Domain Commands
- Data operations → Domain Services  
- Interface concerns → Adapters

## Migration Guide

### Moving Existing Tests

1. **Identify what the test actually tests:**
   - Domain business logic → Move to `__tests__/domain/commands/`
   - Command registration → Move to `__tests__/adapters/`

2. **Update imports:**
   - Add `src/` prefix to all import paths
   - Verify all imports resolve correctly

3. **Rename files:**
   - Domain commands: `[module].commands.test.ts`
   - Adapters: `[interface].[module].adapter.test.ts`

4. **Verify tests still pass:**
   - Run tests individually first
   - Then run the full suite

### Example Migration

```bash
# Before (confusing)
src/adapters/__tests__/integration/tasks.test.ts

# After (clear)
__tests__/domain/commands/tasks.commands.test.ts
```

## Test Discovery Configuration

Update your test configuration to find tests in the new locations:

```javascript
{
  "testMatch": [
    "**/__tests__/**/*.test.ts",
    "**/src/**/*.test.ts"
  ]
}
```

## Benefits of This Architecture

### Short-term
- **Eliminates confusion** about what each test validates
- **Improves test discoverability** with logical organization
- **Clearer understanding** of architectural boundaries
- **Better development experience** with organized tests

### Long-term
- **Prevents future architectural confusion**
- **Faster onboarding** for new developers
- **Maintainable test growth** with clear patterns
- **Foundation for advanced testing** (parallel execution, etc.)

## Conclusion

This test architecture ensures that:
1. **Tests are easy to find** based on what they test
2. **Test purposes are clear** from their location and naming
3. **Architectural boundaries are respected** and reinforced
4. **New tests follow consistent patterns**

When writing new tests, always start by asking: **"What layer am I testing?"** The answer will guide you to the right location and approach. 
