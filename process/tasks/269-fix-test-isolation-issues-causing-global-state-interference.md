# Task #269: Fix test isolation issues causing global state interference

## 🎯 **Objective**

Eliminate **global state pollution** and **singleton interference** that causes tests to pass individually but fail when run in the full test suite, achieving complete test isolation.

## ✅ **MAJOR PROGRESS COMPLETED**

### **🔥 Breakthrough: Dependency Injection Pattern Established**

**Key Innovation:** Instead of cleaning up global state modifications, we **eliminated the need for global state modification entirely** through better architectural design using dependency injection.

### **✅ SessionDB Singleton - ELIMINATED**
- **Before:** Global singleton persisted state across ALL tests
- **After:** Dependency injection with `createSessionDB()` factory function
- **Implementation:** Added dependency injection to `sessionPrFromParams()` function
- **Result:** Zero SessionDB state pollution between tests

### **✅ Process.env Pollution - ELIMINATED** 
- **Before:** Tests modified `process.env` with cleanup patterns
- **After:** Configuration overrides using `ConfigurationLoader.loadConfiguration(workingDir, configOverrides)`
- **Implementation:** Refactored 7 configuration tests to use mock configuration objects
- **Result:** Zero environment variable pollution, parallel-test ready

### **🚀 Pattern Transformation Achievement:**
```typescript
// ❌ OLD: Global state pollution
process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
// Test logic + cleanup in afterEach()

// ✅ NEW: Dependency injection
const configOverrides = { sessiondb: { backend: "sqlite" } };
const config = await loader.loadConfiguration(workingDir, configOverrides);
```

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

### **Isolation Issues Status:**
1. ✅ **SessionDB Singleton** - FIXED with dependency injection
2. ✅ **Process.env Pollution** - FIXED with configuration overrides 
3. 🔄 **Storage Backend Conflicts** - IN PROGRESS (EnhancedStorageBackendFactory singleton)
4. 🔄 **Variable Naming Mismatches** - IN PROGRESS (causing infinite loops in tests)
5. ⏳ **File System State** - Tests creating/modifying files without cleanup
6. ⏳ **Directory Dependencies** - Tests changing process.cwd() affect others

## 🔍 **Remaining Issues to Address**

### **1. Storage Backend Singleton (NEXT PRIORITY)**
```typescript
// Problem: EnhancedStorageBackendFactory singleton causes conflicts
class EnhancedStorageBackendFactory {
  private static _instance: EnhancedStorageBackendFactory;
  // Similar pattern to SessionDB - needs dependency injection
}
```

**Status:** Identified as next high-priority global state issue.

### **2. Variable Naming Mismatches (CRITICAL)**
```typescript
// Problem: Variable definition/usage mismatches cause infinite loops
const _workspacePath = getWorkspacePath();  // Defined with underscore
return workspacePath.resolve();             // Used without underscore - UNDEFINED!
```

**Impact:** Tests running for 4+ billion milliseconds (infinite execution)
**Evidence:** Task #224 revealed infinite loops causing 99.999% execution time waste

### **3. Configuration System Pollution (PARTIALLY FIXED)**
**Status:** ConfigurationLoader fixed, but other config components may still have issues.

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

### **✅ Phase 1: SessionDB Singleton Elimination - COMPLETED**
1. ✅ **Identified all SessionDB usage** in tests
2. ✅ **Replaced singleton with dependency injection** pattern
3. ✅ **Each test gets fresh SessionDB instance** via `createSessionDB()`
4. ✅ **Added proper dependency injection** to domain functions

**Result:** Zero SessionDB state pollution between tests.

### **✅ Phase 2: Process.env Cleanup - COMPLETED**
1. ✅ **Audited all process.env usage** in configuration tests
2. ✅ **Replaced environment variable injection** with configuration overrides
3. ✅ **Converted to dependency injection** using `ConfigurationLoader.loadConfiguration(workingDir, configOverrides)`
4. ✅ **Eliminated all beforeEach/afterEach cleanup** (no longer needed)

**Result:** Zero environment variable pollution. Tests are parallel-ready.

### **🔄 Phase 3: Storage Backend Isolation - IN PROGRESS**
1. 🔄 **Audit EnhancedStorageBackendFactory usage** in tests
2. ⏳ **Replace singleton with dependency injection** pattern
3. ⏳ **Ensure each test gets fresh backend instance**
4. ⏳ **Add proper cleanup/reset between tests**

### **🔄 Phase 4: Variable Naming Fix - IN PROGRESS** 
1. 🔄 **Fix variable definition/usage mismatches** causing infinite loops
2. ⏳ **Apply variable-naming-protocol rule** systematically
3. ⏳ **Verify no more infinite execution deadlocks**
4. ⏳ **Add proper variable naming validation**

### **⏳ Phase 5: File System Cleanup - PENDING**
1. ⏳ **Audit file creation/modification** in tests
2. ⏳ **Add proper cleanup** for temporary files/directories
3. ⏳ **Use isolated test directories** for each test
4. ⏳ **Implement teardown patterns**

### **⏳ Phase 6: Working Directory Isolation - PENDING**
1. ⏳ **Identify process.cwd() changes** in tests
2. ⏳ **Save and restore working directory** in test setup/teardown
3. ⏳ **Use absolute paths** instead of relative paths where possible
4. ⏳ **Add working directory reset** between tests

## 🎯 **Success Criteria**

### **Primary Goal:**
- [ ] **Tests pass individually = Tests pass in full suite** (100% consistency)
- [x] **Zero SessionDB state leakage** between tests ✅
- [x] **Zero process.env pollution** between tests ✅
- [ ] **Zero storage backend conflicts** between tests
- [ ] **Complete test isolation** - each test starts with clean state

### **Measurable Outcomes:**
- [ ] **Same pass rate** when running tests individually vs. full suite
- [x] **Zero process.env pollution** (ConfigurationLoader refactored) ✅
- [x] **Zero SessionDB leakage** (dependency injection implemented) ✅
- [ ] **Zero storage backend conflicts** between tests
- [ ] **Zero file system state leakage** between tests
- [ ] **Zero working directory interference** between tests

### **Test Suite Health:**
- [ ] **>95% pass rate** maintained with proper isolation
- [ ] **Consistent test results** across multiple runs
- [ ] **Fast test execution** without isolation overhead

## 🔍 **Proven Implementation Patterns**

### **✅ 1. Dependency Injection for Singletons (ESTABLISHED)**
```typescript
// ❌ Before: Global singleton
const sessionDB = SessionDB.getInstance();

// ✅ After: Dependency injection
export function createSessionDB(): SessionProviderInternal {
  return createSessionProviderInternal();
}

// Usage in functions:
export async function sessionPrFromParams(
  params: SessionPrParams,
  depsInput?: { SessionDB?: SessionProviderInternal; GitService?: GitService }
): Promise<SessionPrResult> {
  const deps = depsInput || {
    SessionDB: createSessionDB(),
    GitService: new GitService()
  };
  // Function uses injected dependencies
}
```

### **✅ 2. Configuration Override Pattern (ESTABLISHED)**
```typescript
// ❌ Before: Environment variable pollution
beforeEach(() => {
  process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
});
afterEach(() => {
  delete process.env.MINSKY_SESSIONDB_BACKEND; // Cleanup
});

// ✅ After: Configuration overrides
test("should use SQLite backend", async () => {
  const configOverrides = {
    sessiondb: { backend: "sqlite", dbPath: "/test/path" }
  };
  const config = await loader.loadConfiguration(testDir, configOverrides);
  // No global state modification needed
});
```

### **⏳ 3. Storage Backend Injection (TO IMPLEMENT)**
```typescript
// ❌ Current: Storage backend singleton
const backend = EnhancedStorageBackendFactory.getInstance();

// ✅ Target: Storage backend dependency injection
function createStorageBackend(): EnhancedStorageBackend {
  return new EnhancedStorageBackend();
}
```

### **⏳ 4. File System Cleanup (TO IMPLEMENT)**
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

## 📋 **Updated Action Plan**

### **✅ Step 1: SessionDB & Configuration - COMPLETED**
1. ✅ **Implemented SessionDB dependency injection** with `createSessionDB()` factory
2. ✅ **Refactored ConfigurationLoader** to use configuration overrides
3. ✅ **Eliminated process.env modifications** in 7 configuration tests
4. ✅ **Verified zero global state pollution** in these domains

### **🔄 Step 2: Storage Backend & Variable Naming - IN PROGRESS**
1. 🔄 **Audit EnhancedStorageBackendFactory singleton** usage
2. 🔄 **Fix variable naming mismatches** causing infinite loops
3. ⏳ **Implement storage backend dependency injection**
4. ⏳ **Verify elimination of infinite execution deadlocks**

### **⏳ Step 3: File System & Directory Isolation - PENDING**
1. ⏳ **Implement file system cleanup** patterns
2. ⏳ **Add working directory save/restore** patterns
3. ⏳ **Convert to absolute paths** where needed
4. ⏳ **Add isolation helpers** for common patterns

### **⏳ Step 4: Comprehensive Verification - PENDING**
1. ⏳ **Run individual tests** to establish baseline
2. ⏳ **Run full suite** and compare results
3. ⏳ **Achieve 100% consistency** between individual and suite runs
4. ⏳ **Document proven patterns** for future development

## 🛠️ **Tools and Techniques**

### **Detection Tools:**
- **ESLint rules** for process.env usage ✅
- **Variable naming protocol** for underscore mismatches 🔄
- **Test result comparison** (individual vs. suite)
- **State monitoring** between tests

### **✅ Proven Cleanup Patterns:**
- **Dependency injection** instead of singletons ✅
- **Configuration overrides** instead of environment variable modification ✅
- **Factory functions** for creating fresh instances ✅
- **beforeEach/afterEach** hooks eliminated where possible ✅

### **🔄 Isolation Techniques In Progress:**
- **Fresh storage backends** for each test 🔄
- **Variable naming validation** to prevent infinite loops 🔄
- **State snapshots** and restoration ⏳
- **Isolated test environments** ⏳

## 📈 **Expected Impact**

### **✅ Achieved Benefits:**
- **Eliminated SessionDB flakiness** caused by singleton state ✅
- **Eliminated process.env pollution** in configuration domain ✅
- **Established dependency injection patterns** for global state elimination ✅
- **Created foundation for parallel test execution** ✅

### **🔄 In-Progress Benefits:**
- **Eliminating storage backend conflicts** 🔄
- **Fixing infinite loop deadlocks** from variable naming issues 🔄
- **Reducing debugging time** spent on test interference issues 🔄

### **⏳ Remaining Benefits:**
- **Achieve >95% pass rate** with stable, isolated tests ⏳
- **Reliable CI/CD pipeline** with consistent test results ⏳
- **Complete foundation for parallel test execution** ⏳

## 📝 **Implementation Checklist**

### **✅ Phase 1: SessionDB Singleton - COMPLETED**
- [x] Audit all SessionDB.getInstance() usage
- [x] Replace with dependency injection pattern (`createSessionDB()`)
- [x] Add SessionDB injection to domain functions
- [x] Verify isolation with targeted tests

### **✅ Phase 2: Process.env Cleanup - COMPLETED**
- [x] Run ESLint to identify all process.env usage in config tests
- [x] Replace with configuration override patterns
- [x] Remove all environment variable modification and cleanup
- [x] Verify no leakage between tests (7/7 config tests pass)

### **🔄 Phase 3: Storage Backend System - IN PROGRESS**
- [x] Audit EnhancedStorageBackendFactory singleton usage
- [ ] Implement storage backend dependency injection
- [ ] Add storage backend isolation helpers
- [ ] Verify storage backend independence

### **🔄 Phase 4: Variable Naming Fixes - IN PROGRESS**
- [x] Identify variable naming mismatches causing infinite loops
- [ ] Apply variable-naming-protocol rule systematically
- [ ] Fix definition/usage mismatches (e.g., `_workspacePath` vs `workspacePath`)
- [ ] Verify elimination of infinite execution deadlocks

### **⏳ Phase 5: File System Cleanup - PENDING**
- [ ] Audit all file system operations in tests
- [ ] Implement temporary directory patterns
- [ ] Add proper cleanup in teardown
- [ ] Verify no file system leakage

### **⏳ Phase 6: Working Directory - PENDING**
- [ ] Audit all process.cwd() changes
- [ ] Implement directory save/restore patterns
- [ ] Convert to absolute paths where possible
- [ ] Verify directory isolation

**Priority:** HIGH - Test isolation is critical for reliable CI/CD
**Complexity:** HIGH - Requires systematic global state refactoring (**MAJOR PROGRESS MADE**)
**Impact:** HIGH - Eliminates major source of test flakiness (**PARTIALLY ACHIEVED**)
