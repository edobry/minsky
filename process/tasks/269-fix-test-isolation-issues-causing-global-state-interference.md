# Task #269: Fix test isolation issues causing global state interference

## 🎯 **Objective**

Eliminate **global state pollution** and **singleton interference** that causes tests to pass individually but fail when run in the full test suite, achieving complete test isolation.

## 🚨 **Critical Problem Identified**

### **Classic Test Isolation Issue:**
```bash
# Tests pass individually ✅
bun test src/domain/tasks/__tests__/task-backend-router.test.ts  # PASS
bun test src/adapters/__tests__/cli/session.test.ts             # PASS

# But fail in full suite ❌
bun test  # FAIL - same tests fail due to global state interference
```

**Root Cause:** Tests modify global state without proper cleanup, affecting subsequent tests.

## 📊 **Current Evidence**

### **Test Suite Health:**
- **Individual tests:** Most pass when run in isolation
- **Full suite:** ~78 failures due to global state interference
- **Pattern:** Tests pass individually ≠ Tests pass in suite

### **Confirmed Isolation Issues:**
1. **SessionDB Singleton** - Persists state across ALL tests
2. **Process.env Pollution** - Environment variables leak between tests
3. **Configuration System** - Global config state not reset between tests
4. **Directory Dependencies** - Tests changing process.cwd() affect others
5. **File System State** - Tests creating/modifying files without cleanup

## 🔍 **Specific Issues Identified**

### **1. Global SessionDB Singleton (HIGH PRIORITY)**
```typescript
// Problem: Singleton instance persists across ALL tests
class SessionDB {
  private static _instance: SessionDB;
  static getInstance(): SessionDB {
    if (!SessionDB._instance) {
      SessionDB._instance = new SessionDB();
    }
    return SessionDB._instance; // ❌ Same instance across all tests
  }
}
```

**Impact:** Session data from one test leaks into subsequent tests.

### **2. Process.env Pollution (DETECTED)**
```typescript
// ESLint rule catches these, but some still exist
test("workspace test", () => {
  process.env.HOME = "/test/path";  // ❌ Pollutes global state
  // Missing cleanup - affects subsequent tests
});
```

**Evidence:** Found in workspace.test.ts and other files.

### **3. Configuration System Pollution**
```typescript
// Tests modify global configuration without reset
test("config test", () => {
  config.set("sessiondb.adapter", "memory");  // ❌ Global state change
  // No cleanup - affects subsequent tests
});
```

**Status:** Partially fixed in some files, but violations remain.

### **4. File System State Leakage**
```typescript
// Tests create files/directories without cleanup
test("creates session", () => {
  await fs.mkdir("/tmp/test-session");  // ❌ Not cleaned up
  // Files persist, affecting subsequent tests
});
```

### **5. Working Directory Dependencies**
```typescript
// Tests that change process.cwd() without restoration
test("workspace operations", () => {
  process.chdir("/some/test/path");  // ❌ Changes global state
  // No restoration - affects subsequent tests
});
```

## 🔧 **Systematic Fix Strategy**

### **Phase 1: SessionDB Singleton Elimination**
1. **Identify all SessionDB usage** in tests
2. **Replace singleton with dependency injection** for tests
3. **Ensure each test gets fresh SessionDB instance**
4. **Add proper cleanup/reset between tests**

### **Phase 2: Process.env Cleanup**
1. **Audit all process.env usage** in tests (ESLint helps)
2. **Implement proper cleanup** in beforeEach/afterEach
3. **Convert to dependency injection** where possible
4. **Add ESLint rules** to prevent new violations

### **Phase 3: Configuration System Isolation**
1. **Identify configuration pollution** in tests
2. **Implement configuration reset** between tests
3. **Use test-specific configuration** instead of global config
4. **Add proper cleanup patterns**

### **Phase 4: File System Cleanup**
1. **Audit file creation/modification** in tests
2. **Add proper cleanup** for temporary files/directories
3. **Use isolated test directories** for each test
4. **Implement teardown patterns**

### **Phase 5: Working Directory Isolation**
1. **Identify process.cwd() changes** in tests
2. **Save and restore working directory** in test setup/teardown
3. **Use absolute paths** instead of relative paths where possible
4. **Add working directory reset** between tests

## 🎯 **Success Criteria**

### **Primary Goal:**
- [ ] **Tests pass individually = Tests pass in full suite** (100% consistency)
- [ ] **Zero global state leakage** between tests
- [ ] **Complete test isolation** - each test starts with clean state

### **Measurable Outcomes:**
- [ ] **Same pass rate** when running tests individually vs. full suite
- [ ] **Zero process.env pollution** (ESLint rule passes)
- [ ] **Zero configuration leakage** between tests
- [ ] **Zero file system state leakage** between tests
- [ ] **Zero working directory interference** between tests

### **Test Suite Health:**
- [ ] **>95% pass rate** maintained with proper isolation
- [ ] **Consistent test results** across multiple runs
- [ ] **Fast test execution** without isolation overhead

## 🔍 **Implementation Patterns**

### **1. Dependency Injection for Singletons**
```typescript
// ❌ Before: Global singleton
const sessionDB = SessionDB.getInstance();

// ✅ After: Dependency injection
function createSessionDB(): SessionDB {
  return new SessionDB();
}

test("session test", () => {
  const sessionDB = createSessionDB();  // Fresh instance per test
  // Test uses isolated instance
});
```

### **2. Environment Variable Cleanup**
```typescript
// ✅ Proper cleanup pattern
describe("tests with env vars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };  // Reset to original
  });

  afterEach(() => {
    process.env = originalEnv;  // Restore original
  });
});
```

### **3. Configuration Reset Pattern**
```typescript
// ✅ Configuration isolation
describe("config tests", () => {
  let originalConfig: Config;

  beforeEach(() => {
    originalConfig = config.clone();  // Save original
    config.clear();  // Start with clean config
  });

  afterEach(() => {
    config.restore(originalConfig);  // Restore original
  });
});
```

### **4. File System Cleanup**
```typescript
// ✅ Temporary directory pattern
describe("file system tests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp("/tmp/test-");  // Isolated temp dir
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true });  // Clean up
  });
});
```

## 📋 **Detailed Action Plan**

### **Step 1: Audit and Document**
1. **Run comprehensive audit** of all global state usage
2. **Document specific violations** with file locations
3. **Categorize by type** (singleton, env, config, file system, etc.)
4. **Prioritize by impact** (high-frequency failures first)

### **Step 2: Implement Fixes**
1. **Start with SessionDB singleton** (highest impact)
2. **Fix process.env pollution** (ESLint helps identify)
3. **Implement configuration isolation** patterns
4. **Add file system cleanup** patterns
5. **Fix working directory issues**

### **Step 3: Verify Isolation**
1. **Run individual tests** to establish baseline
2. **Run full suite** and compare results
3. **Identify remaining discrepancies**
4. **Iterate until consistent**

### **Step 4: Prevention**
1. **Add ESLint rules** for common violations
2. **Update testing guidelines** with isolation patterns
3. **Add pre-commit hooks** to catch violations
4. **Document best practices** for future tests

## 🛠️ **Tools and Techniques**

### **Detection Tools:**
- **ESLint rules** for process.env usage
- **Static analysis** for singleton pattern usage
- **Test result comparison** (individual vs. suite)
- **State monitoring** between tests

### **Cleanup Patterns:**
- **beforeEach/afterEach** hooks for state reset
- **Dependency injection** instead of singletons
- **Test-specific configurations** and databases
- **Temporary directories** for file system tests

### **Isolation Techniques:**
- **Fresh instances** for each test
- **State snapshots** and restoration
- **Mocking global dependencies** instead of using real ones
- **Isolated test environments**

## 📈 **Expected Impact**

### **Short-term (Task #269):**
- **Eliminate test flakiness** caused by global state
- **Achieve consistent results** between individual and suite runs
- **Reduce debugging time** spent on test interference issues

### **Long-term (Test Suite Quality):**
- **Reliable CI/CD pipeline** with consistent test results
- **Faster development cycle** without test isolation debugging
- **Maintainable test suite** with clear isolation patterns
- **Foundation for parallel test execution**

## 🔄 **Relationship to Other Tasks**

### **Complements Task #268:**
- Task #268: Eliminates testing-boundaries violations
- Task #269: Fixes test isolation and global state issues
- **Together:** Achieve >95% pass rate with stable, isolated tests

### **Enables Future Development:**
- **Parallel test execution** becomes possible with proper isolation
- **Reliable test results** enable confident deployments
- **Clear testing patterns** for new test development

---

## 📝 **Implementation Checklist**

### **Phase 1: SessionDB Singleton**
- [ ] Audit all SessionDB.getInstance() usage
- [ ] Replace with dependency injection pattern
- [ ] Add SessionDB reset between tests
- [ ] Verify isolation with targeted tests

### **Phase 2: Process.env Cleanup**
- [ ] Run ESLint to identify all process.env usage
- [ ] Implement proper cleanup patterns
- [ ] Add environment variable reset hooks
- [ ] Verify no leakage between tests

### **Phase 3: Configuration System**
- [ ] Audit all configuration modifications in tests
- [ ] Implement configuration reset patterns
- [ ] Add config isolation helpers
- [ ] Verify configuration independence

### **Phase 4: File System Cleanup**
- [ ] Audit all file system operations in tests
- [ ] Implement temporary directory patterns
- [ ] Add proper cleanup in teardown
- [ ] Verify no file system leakage

### **Phase 5: Working Directory**
- [ ] Audit all process.cwd() changes
- [ ] Implement directory save/restore patterns
- [ ] Convert to absolute paths where possible
- [ ] Verify directory isolation

**Priority:** HIGH - Test isolation is critical for reliable CI/CD
**Complexity:** HIGH - Requires systematic global state refactoring
**Impact:** HIGH - Eliminates major source of test flakiness
