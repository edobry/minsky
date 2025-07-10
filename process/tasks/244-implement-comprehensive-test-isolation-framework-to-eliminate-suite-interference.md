# Fix test failures by following testing-boundaries rules and eliminating global state interference

## Status

**IN-PROGRESS** - Critical infrastructure task to resolve systematic test failures

## Priority

**HIGH** - Blocks development productivity and CI/CD reliability

## 🎯 **Key Discovery: Testing-Boundaries Rule Violations**

### **Root Cause Analysis - BREAKTHROUGH**

**The real problem:** We've been violating established `testing-boundaries` rules by:
- ❌ **Testing interface layers** (CLI commands, MCP tools) instead of domain logic
- ❌ **Using global singletons** like `SessionDB` that share state across tests
- ❌ **Over-engineering solutions** with complex "TestIsolationFramework" instead of following established patterns

**Evidence:**
- **Domain tests pass individually** (95-100% success rate)
- **Same tests fail in full suite** due to global state interference
- **Interface tests are less reliable** but we were focusing on them

### **Testing-Boundaries Compliance Issues**

According to our established rules:

**✅ SHOULD Test:**
- Domain logic and business rules
- Pure functions with predictable inputs/outputs
- Error handling and edge cases
- Data transformations

**❌ SHOULD NOT Test:**
- CLI command interfaces directly
- MCP tool interaction patterns
- Framework internals (Commander.js, Winston, etc.)
- Console output formatting

**Current Violations:**
- Most failing tests are testing **adapters/interfaces** instead of **domain logic**
- Using `spyOn()` to mock domain functions from command tests
- Testing "command calls domain function" instead of testing domain behavior

## 📊 **Current Status**

### **Test Results by Layer**
- **Domain tests**: 465 pass, 121 fail = **79.3% pass rate**
- **Interface tests**: 150 pass, 28 fail = **84.3% pass rate**
- **Overall**: 774 pass, 168 fail = **81.5% pass rate**

### **Key Insight**
Domain tests should be our focus because they test **business logic**, even though interface tests currently have higher pass rates.

## 🚨 **Global State Issues Identified**

### **Major Culprits Causing Test Interference**

**1. Global Singleton (SessionDB):**
```typescript
// src/domain/session/index.ts - Line 38
export const SessionDB = createSessionProviderInternal();
```
**Impact:** Shared singleton persists state across ALL tests

**2. Global Configuration Variables:**
```typescript
// src/domain/session/session-db-adapter.ts
let sessionDbConfig: any;
```
**Impact:** Global variable modified by tests, leaks to other tests

**3. Process.cwd() Dependencies:**
```typescript
// Many domain files
workspacePath: process.cwd(),
const currentDir = process.cwd();
```
**Impact:** Tests that change directory affect subsequent tests

## ✅ **Correct Solution - Testing-Boundaries Approach**

### **Domain Function Testing Pattern**

Instead of testing global singletons, test the **pure domain functions** directly:

```typescript
// ✅ GOOD - Test pure domain functions
import { listSessionsFn, getSessionFn, addSessionFn } from "../../domain/session";

test("listSessionsFn returns sessions from state", () => {
  const mockState = { sessions: [mockSession1, mockSession2] };
  const result = listSessionsFn(mockState);
  expect(result).toEqual([mockSession1, mockSession2]);
});
```

```typescript
// ❌ BAD - Test global singleton (causes interference)
import { SessionDB } from "../../domain/session";

test("SessionDB lists sessions", async () => {
  await SessionDB.addSession(mockSession); // Modifies global state!
  const result = await SessionDB.listSessions(); // State leaks to other tests!
});
```

### **Standard Bun Test Patterns**

Simple, effective patterns without over-engineering:

```typescript
describe("Domain Logic Tests", () => {
  let testData: SomeType;

  beforeEach(() => {
    // Setup fresh test data (no global state)
    testData = createMockObjects();
  });

  // Only use afterEach if you modify global state (rarely needed)
});
```

## 🎯 **Updated Implementation Plan**

### **Phase 1: Fix Domain Tests (Primary Focus)**

**Approach:** Refactor domain tests to test pure functions instead of global singletons

**Priority Tests to Fix:**
1. **DefaultBackendDetector** - 13/13 pass individually, fail in suite
2. **EnhancedStorageBackendFactory** - 18/18 pass individually, fail in suite
3. **Configuration Integration** - Pure logic tests

**Implementation Steps:**
1. **Identify domain tests using global singletons**
2. **Replace singleton calls with pure function calls**
3. **Pass state as parameters** instead of relying on global state
4. **Remove unnecessary test complexity** (no mock.restore() unless using spyOn)

### **Phase 2: Eliminate Interface Test Dependencies (Secondary)**

**Approach:** Reduce dependency on interface layer tests

**Implementation Steps:**
1. **Convert interface tests to domain tests** where possible
2. **Remove spyOn() usage** in favor of dependency injection
3. **Focus on integration tests** that test actual behavior end-to-end

### **Phase 3: Simple Global State Management (If Needed)**

**Only if domain testing doesn't resolve interference:**
1. **Isolate global singletons** in tests
2. **Reset global state** between test files (simple approach)
3. **Use dependency injection** in production code

## 📊 **Expected Impact**

### **Quantitative Improvements**
- **Domain test pass rate:** 79.3% → 95%+ by eliminating global state interference
- **Overall test pass rate:** 81.5% → 95%+
- **Test reliability:** Consistent results between individual and suite execution

### **Qualitative Benefits**
- **Simpler test code** - No complex isolation frameworks
- **Better test design** - Testing actual business logic
- **Faster debugging** - Clear separation of concerns
- **Maintainable tests** - Following established patterns

## 🎯 **Success Criteria**

### **Primary Objectives**
- [ ] **Domain test consistency:** <2% difference between individual and suite execution
- [ ] **Overall pass rate:** Increase from 81.5% to 95%+ (774 → 902+ passing tests)
- [ ] **Testing-boundaries compliance:** All tests follow established rules
- [ ] **Simplified test code:** Remove over-engineered isolation complexity

### **Technical Deliverables**
- [ ] **Domain tests refactored** to test pure functions instead of singletons
- [ ] **Global state issues resolved** through proper test design
- [ ] **Standard Bun test patterns** applied consistently
- [ ] **Interface test dependencies reduced** in favor of domain logic testing

## 🔧 **Implementation Examples**

### **SessionDB Singleton Refactor**

```typescript
// Before: Testing global singleton (causes interference)
import { SessionDB } from "../../domain/session";
test("should list sessions", async () => {
  const sessions = await SessionDB.listSessions(); // Global state!
});

// After: Testing pure domain function (no interference)
import { listSessionsFn } from "../../domain/session";
test("should list sessions", () => {
  const mockState = { sessions: [session1, session2] };
  const result = listSessionsFn(mockState);
  expect(result).toEqual([session1, session2]);
});
```

### **Configuration Testing Refactor**

```typescript
// Before: Testing through singleton with global state
import { configService } from "../../domain/configuration";
test("should detect backend", async () => {
  const backend = await configService.detectBackend(); // Global file system state!
});

// After: Testing pure detection logic
import { detectBackendFromFiles } from "../../domain/configuration";
test("should detect backend", () => {
  const mockFiles = { '.minsky/tasks.json': true, 'process/tasks.md': false };
  const result = detectBackendFromFiles(mockFiles);
  expect(result).toBe('json-file');
});
```

## 📝 **Key Learnings**

1. **Testing-boundaries rules exist for a reason** - Interface testing leads to brittle, complex tests
2. **Global singletons are the enemy of reliable tests** - Pure functions are testable by design
3. **Simple is better than complex** - Standard patterns work better than custom frameworks
4. **Domain logic is what matters** - Focus testing effort on business rules, not wiring
5. **Individual test success ≠ suite success** - Global state interference is the gap

## 🔗 **Related Tasks**

- **Task #236:** Fix test failures and infinite loops (identified symptoms)
- **Follow-up:** Remove over-engineered test utilities that aren't needed
- **Follow-up:** Document domain testing patterns for future development

## 📊 **Progress Tracking**

### **✅ Completed**
- [x] **Root cause analysis** - Identified testing-boundaries violations and global state issues
- [x] **Database Integrity Checker** - Fixed permission error test (24/24 pass individually)
- [x] **Parameter Schemas** - Fixed missing import (test now passes)
- [x] **Simplified test patterns** - Removed over-engineered TestIsolationFramework complexity

### **🚧 In Progress**
- [ ] **Domain test refactoring** - Convert singleton tests to pure function tests
- [ ] **Global state elimination** - Remove test dependencies on shared singletons

### **⏳ Not Started**
- [ ] **Interface test reduction** - Focus on domain logic instead of command layer
- [ ] **Final verification** - Achieve 95%+ pass rate through proper test design

**Current Focus:** Refactor domain tests to test pure functions instead of global singletons, starting with DefaultBackendDetector and EnhancedStorageBackendFactory tests.
