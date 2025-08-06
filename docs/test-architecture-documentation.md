# Test Architecture Documentation and Guidelines

> **Comprehensive guide to the Minsky test architecture that achieved 100% test success rate (1458/1458 tests)**

## Table of Contents

1. [Overview](#overview)
2. [Core Principles](#core-principles)
3. [Proven Success Patterns](#proven-success-patterns)
4. [Test Organization](#test-organization)
5. [Testing Utilities](#testing-utilities)
6. [ESLint Integration](#eslint-integration)
7. [Migration Guidelines](#migration-guidelines)
8. [Common Anti-Patterns](#common-anti-patterns)
9. [Troubleshooting Guide](#troubleshooting-guide)
10. [Quick Reference](#quick-reference)

## Overview

The Minsky project has developed a robust test architecture that achieved **100% test success rate** (1458/1458 tests) through systematic application of proven patterns and architectural principles. This documentation consolidates all the knowledge, patterns, and guidelines that made this success possible.

### Key Achievement Metrics

- **Total Tests**: 1458 tests
- **Success Rate**: 100% (0 failures)
- **Framework**: Bun test with custom utilities
- **Architecture**: Domain-driven with dependency injection
- **Isolation**: Complete test isolation preventing cross-test interference

## Core Principles

### 1. **Domain-First Testing**
Test business logic and domain methods directly, not interface layers.

```typescript
// ❌ WRONG: Testing CLI interface
const { stdout } = await execAsync('minsky task create "Test Task"');
expect(stdout).toContain('Task created');

// ✅ CORRECT: Testing domain logic
const task = await createTaskFromParams({ title: "Test Task" });
expect(task.title).toBe("Test Task");
```

### 2. **Centralized Test Utilities**
Always use project-specific test utilities instead of direct framework APIs.

```typescript
// ❌ WRONG: Direct bun:test APIs
import { mock } from "bun:test";
const mockFn = mock();

// ✅ CORRECT: Centralized utilities
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";
setupTestMocks();
const mockFn = createMock();
```

### 3. **Dependency Injection for Testability**
Use dependency injection patterns to enable reliable testing.

```typescript
// ❌ WRONG: Hard dependencies
export async function createSession(taskId: string) {
  const taskService = new TaskService(); // Hard dependency
  return taskService.createSession(taskId);
}

// ✅ CORRECT: Dependency injection
export async function createSessionWithDependencies(
  taskId: string,
  deps: { taskService: TaskService }
) {
  return deps.taskService.createSession(taskId);
}
```

### 4. **Test Isolation**
Prevent cross-test interference through proper cleanup and isolation.

```typescript
describe("Test Suite", () => {
  setupTestMocks(); // Automatic cleanup
  
  beforeEach(() => {
    // Reset mocks to known state
    mockService.mockClear();
  });
});
```

## Proven Success Patterns

These patterns were discovered through systematic test fixing and achieved 100% success rate:

### 1. **Explicit Mock Pattern** 🎯

**Problem**: Factory-generated mocks with async functions are unreliable  
**Success Rate**: 100% when applied correctly

```typescript
// ❌ UNRELIABLE: Factory-generated mock
const mockService = createMockService(async (id) => {
  if (id === "test") return mockData;
  return null;
});

// ✅ RELIABLE: Explicit Mock Pattern
const mockService = {
  getData: async (id: string) => {
    if (id === "test") {
      return { id: "test", name: "Test Item" };
    }
    return null;
  },
  listItems: async () => [],
  updateItem: async () => {},
  deleteItem: async () => false,
  // All methods explicitly defined
};
```

**Key Benefits**:
- ✅ Reliable mock construction
- ✅ All required methods explicitly defined
- ✅ Predictable behavior
- ✅ Handles both input and qualified ID formats

### 2. **Template Literal Pattern** 🎯

**Problem**: Repeated string construction leads to format mismatches  
**Success Rate**: 100% for eliminating magic string errors

```typescript
// ❌ PROBLEMATIC: Magic strings and repetition
expect(result.id).toBe("user-123");
expect(result.name).toBe("user-123-session");
expect(commands).toContain("process user-123 for session user-123-session");

// ✅ RELIABLE: Template Literal Pattern
const USER_ID = "123";
const QUALIFIED_ID = `user-${USER_ID}`;
const SESSION_NAME = `${QUALIFIED_ID}-session`;
const COMMAND = `process ${QUALIFIED_ID} for session ${SESSION_NAME}`;

expect(result.id).toBe(QUALIFIED_ID);
expect(result.name).toBe(SESSION_NAME);
expect(commands).toContain(COMMAND);
```

### 3. **Format Alignment Pattern** 🎯

**Problem**: Mock data format doesn't match system-generated formats  
**Success Rate**: 100% for format-related test failures

```typescript
// ❌ MISALIGNED: Mock format doesn't match system format
const mockDatabase = {
  getRecord: (id: string) => Promise.resolve({
    name: `item${id}`, // → "item123" (no separator) ❌
    path: `data/item${id}`, // → "data/item123" (inconsistent) ❌
  })
};

// ✅ ALIGNED: Mock format matches system format
const mockDatabase = {
  getRecord: (id: string) => Promise.resolve({
    name: `item-${id}`, // → "item-123" (with separator) ✅
    path: `data/item-${id}`, // → "data/item-123" (consistent) ✅
  })
};
```

### 4. **Cross-Test Interference Prevention** 🎯

**Problem**: Global `mock.module()` calls persist across tests  
**Root Cause**: Tests passing in isolation but failing in full suite

```typescript
// ❌ DANGEROUS: Global module mocks that persist
mock.module("../utils/logger", () => ({
  log: mockLog,
}));

// ✅ SAFE: Use dependency injection instead
const dependencies = {
  logger: mockLogger,
  database: mockDatabase,
  service: mockService,
};
```

### 5. **Testable Design Pattern** 🎯

**Problem**: Complex functions with I/O operations are hard to unit test  
**Solution**: Extract pure business logic for focused unit testing

```typescript
// ❌ COMPLEX: Function with mixed concerns
async function processData(params, deps) {
  // Complex I/O operations, business logic, notifications, etc.
  if (!params.skipValidation && hasErrors) {
    await validationService.validate();
  }
}

// ✅ EXTRACTED: Pure business logic functions
export function shouldValidate(options: ProcessOptions, state: ProcessState): boolean {
  if (options.force) return false;
  if (options.skipValidation) return false;
  return state.hasErrors;
}
```

## Benefits of This Architecture

1. **Proven Success**: 100% test success rate achieved through systematic approach
2. **Architectural Clarity**: Clear separation between business logic and I/O operations
3. **Test Reliability**: No cross-test interference or isolation issues
4. **Performance**: Fast test execution with proper dependency injection
5. **Maintainability**: Template literals and explicit mocks reduce maintenance burden
6. **Debugging**: Root cause investigation over symptom masking
7. **Consistency**: All tests use the same proven patterns across the codebase

---

*This documentation represents the collective knowledge from achieving 100% test success rate (1458/1458 tests) in the Minsky project. Follow these patterns to ensure reliable, maintainable tests.*

*For detailed implementation guides, migration procedures, and daily development workflows, see the complete documentation suite in `docs/testing/`.*
