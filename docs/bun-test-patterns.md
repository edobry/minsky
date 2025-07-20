# Bun Test Patterns for Minsky

## Overview

This document establishes the required testing patterns for the Minsky codebase using Bun's native test runner. All tests must follow these patterns to ensure consistency, maintainability, and proper integration with our centralized mocking utilities.

## Required Testing Framework

**✅ REQUIRED: Bun Test Runner**
- Use `bun:test` for all testing
- Use Bun's native `mock()`, `expect()`, and test tracking
- Use centralized factory functions for service mocks

**❌ PROHIBITED: Jest Patterns**
- No Jest-style mocking patterns (`.mockImplementation()`, `.mockResolvedValue()`, etc.)
- No `jest.fn()` or `jest.mock()` usage
- No Jest-specific test utilities

## Core Testing Imports

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
```

## Mocking Patterns

### 1. Basic Function Mocks

**✅ Correct Bun Pattern:**
```typescript
import { mock } from "bun:test";

const mockFunction = mock(() => "default-value");

// Change implementation
mockFunction.mockImplementation(() => "new-value");

// Verify calls
expect(mockFunction).toHaveBeenCalledWith("expected-arg");
```

**❌ Prohibited Jest Pattern:**
```typescript
// DON'T USE THESE
const mockFunction = jest.fn();
mockFunction.mockReturnValue("value");
mockFunction.mockResolvedValue(Promise.resolve("value"));
```

### 2. Service Mocks - Use Centralized Factories

**✅ Correct Pattern - Use Centralized Factories:**
```typescript
import { createMockSessionProvider, createMockGitService, createMockTaskService } from "../utils/test-utils";

describe("My Service Tests", () => {
  let mockSessionDB: ReturnType<typeof createMockSessionProvider>;
  let mockGitService: ReturnType<typeof createMockGitService>;

  beforeEach(() => {
    mockSessionDB = createMockSessionProvider();
    mockGitService = createMockGitService();
  });

  test("should work with mocks", () => {
    // Override specific methods if needed
    mockSessionDB.getSession.mockImplementation(() => Promise.resolve(testSession));
    
    // Test your code
    // ...
    
    // Verify calls
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("session-name");
  });
});
```

**❌ Prohibited Pattern - Manual Mock Creation:**
```typescript
// DON'T DO THIS - Creates duplication and inconsistency
const mockSessionDB = {
  getSession: mock(() => Promise.resolve(null)),
  addSession: mock(() => Promise.resolve()),
  // ... manually creating all methods
};
```

### 3. Module Mocking

**✅ Correct Pattern:**
```typescript
import { mock } from "bun:test";
import { mockLoggerModule } from "../utils/test-utils/logger-mock";

// Mock external modules
mock.module("../utils/exec", () => ({
  execAsync: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
}));

// Use centralized logger mock
const mockLog = mockLoggerModule();
```

### 4. Mock Cleanup

**✅ Correct Pattern:**
```typescript
import { clearLoggerMocks } from "../utils/test-utils/logger-mock";

describe("Tests", () => {
  beforeEach(() => {
    // Clear all mocks
    mockFunction.mockClear();
    clearLoggerMocks(mockLog);
    
    // Reset to default implementations if needed
    mockService.method.mockImplementation(() => "default");
  });
});
```

## Centralized Mock Factories

### Available Factories

1. **`createMockSessionProvider()`** - Complete SessionProvider interface
2. **`createMockGitService()`** - Complete GitService interface  
3. **`createMockTaskService()`** - Complete TaskService interface
4. **`createMockLogger()`** - Complete logger interface
5. **`mockLoggerModule()`** - Module-level logger mock

### Factory Usage Pattern

```typescript
import { createMockSessionProvider } from "../utils/test-utils";

describe("Service Tests", () => {
  let mockSessionDB: ReturnType<typeof createMockSessionProvider>;

  beforeEach(() => {
    mockSessionDB = createMockSessionProvider({
      // Override specific methods if needed
      getSession: mock(() => Promise.resolve(customSession)),
    });
  });

  test("uses centralized factory", () => {
    // All methods are available with sensible defaults
    expect(typeof mockSessionDB.getSession).toBe("function");
    expect(typeof mockSessionDB.addSession).toBe("function");
    // ... all other methods available
  });
});
```

## Common Migration Patterns

### Jest → Bun Migration Examples

**Before (Jest Pattern):**
```typescript
const mockService = {
  method: jest.fn().mockResolvedValue("result")
};

beforeEach(() => {
  mockService.method.mockReset();
});
```

**After (Bun Pattern):**
```typescript
const mockService = createMockService({
  method: mock(() => Promise.resolve("result"))
});

beforeEach(() => {
  mockService.method.mockClear();
});
```

## Test Organization

### File Structure
```
src/
  domain/
    service.ts
    service.test.ts      # Co-located tests
  utils/
    test-utils/
      index.ts           # Centralized mock factories
      logger-mock.ts     # Logger-specific utilities
```

### Test Description Patterns

**✅ Good:**
```typescript
describe("ServiceName", () => {
  describe("methodName", () => {
    test("should handle normal case correctly", () => {
      // Test implementation
    });
    
    test("should throw error when input is invalid", () => {
      // Error case testing
    });
  });
});
```

## Error Handling Patterns

### Async Error Testing

**✅ Correct Pattern:**
```typescript
test("should handle async errors", async () => {
  mockService.method.mockImplementation(() => Promise.reject(new Error("Test error")));
  
  await expect(serviceUnderTest.doSomething()).rejects.toThrow("Test error");
});
```

### Synchronous Error Testing

**✅ Correct Pattern:**
```typescript
test("should handle sync errors", () => {
  mockService.method.mockImplementation(() => {
    throw new Error("Test error");
  });
  
  expect(() => serviceUnderTest.doSomething()).toThrow("Test error");
});
```

## Performance Considerations

### Mock Reuse
- Use centralized factories to reduce mock creation overhead
- Clear mocks in `beforeEach` rather than recreating them
- Avoid unnecessary deep object mocking

### Test Isolation
```typescript
describe("Tests", () => {
  beforeEach(() => {
    // Clear state, don't recreate mocks
    mockService.method.mockClear();
    
    // Reset to known state
    mockService.method.mockImplementation(() => "default");
  });
});
```

## Debugging Test Issues

### Common Problems and Solutions

1. **"mockMethod is not a function"**
   - Ensure you're using centralized factories
   - Check that all required methods are included in factory

2. **Mock not being called**
   - Verify mock is properly injected into service under test
   - Check that dependency injection is working correctly

3. **Tests affecting each other**
   - Ensure proper mock clearing in `beforeEach`
   - Use test isolation patterns

## Best Practices Summary

1. **Always use centralized mock factories**
2. **Never use Jest patterns (`.mockReturnValue()`, etc.)**
3. **Clear mocks in `beforeEach`, don't recreate them**
4. **Use descriptive test names**
5. **Test both success and error cases**
6. **Maintain proper test isolation**
7. **Follow co-location for test files**

## ESLint Integration

### Automated Jest Pattern Prevention (✅ IMPLEMENTED)

The Minsky project now includes a custom ESLint rule `no-jest-patterns` that automatically detects and prevents Jest patterns while providing Bun alternatives.

**Rule Configuration:**
```javascript
// eslint.config.js - ALREADY CONFIGURED
export default [
  {
    plugins: {
      custom: {
        rules: {
          "no-jest-patterns": noJestPatterns,
        },
      },
    },
    rules: {
      "custom/no-jest-patterns": "error",
    },
  },
];
```

**Detected Patterns & Auto-fixes:**
- `jest.fn()` → `mock()` (with appropriate import)
- `.mockReturnValue()` → `mock(() => returnValue)`
- `.mockResolvedValue()` → `mock(() => Promise.resolve(value))`
- `.mockRejectedValue()` → `mock(() => Promise.reject(error))`
- `jest.mock()` → Suggests using `mockModule()` from test-utils
- Jest imports → Suggests Bun test imports

**Usage:**
```bash
# Check for Jest patterns
bun lint

# Auto-fix simple patterns  
bun lint --fix
```

The rule runs automatically with `bun lint` and catches violations during development, ensuring consistent Bun test patterns across the codebase.

## Migration Checklist

When migrating a test file:

- [ ] Replace Jest imports with Bun imports
- [ ] Convert manual mocks to centralized factories
- [ ] Replace `.mockReturnValue()` with `.mockImplementation()`
- [ ] Replace `.mockResolvedValue()` with `.mockImplementation(() => Promise.resolve())`
- [ ] Update mock clearing to use `mockClear()` not `mockReset()`
- [ ] Ensure all service dependencies use centralized factories
- [ ] Test that all tests pass with new patterns
- [ ] Verify no Jest patterns remain in the file 
