# Create ESLint rule to forbid real filesystem operations in tests

## Context

## Problem

During Task 176, we discovered multiple test files using real filesystem operations causing:

- Race conditions between concurrent test runs
- Test interference where tests pass individually but fail in test suite
- Infinite loops due to filesystem conflicts (1.6+ billion ms timeouts)
- Non-deterministic test behavior

## Required ESLint Rule

Create ESLint rule at src/eslint-rules/no-real-fs-in-tests.js that:

### Forbidden Imports in Test Files

```javascript
// ❌ FORBIDDEN in test files
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { mkdir, writeFile, readFile, unlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path"; // when used for temp directory creation
```

### Forbidden Function Calls in Test Files

- Any `fs.*` operations (`mkdirSync`, `writeFileSync`, etc.)
- Any `fs/promises.*` operations (`mkdir`, `writeFile`, etc.)
- `tmpdir()` usage for temp directory creation
- `process.cwd()` when used to create temp paths
- Real filesystem setup in `beforeEach`/`afterEach` hooks

### **NEW: Additional Test Interference Patterns**

#### **Global State and Counters**

```javascript
// ❌ FORBIDDEN - Global counters in test files
let testSequenceNumber = 0;
let globalCounter = 0;

describe("tests", () => {
  beforeEach(() => {
    const sequence = ++testSequenceNumber; // Race condition!
  });
});
```

#### **Timestamp-Based "Uniqueness" Patterns**

```javascript
// ❌ FORBIDDEN - Non-unique timestamp patterns
const testDir = join(tmpdir(), `test-${Date.now()}`); // Race condition!
const uniqueId = `${Date.now()}-${Math.random()}`; // Still not unique in parallel!
```

#### **Dynamic Imports in Tests**

```javascript
// ❌ FORBIDDEN - Dynamic imports in test files
const { someFunction } = await import("../module"); // Can cause infinite loops
const module = require("../dynamic-module"); // Problematic in test context
```

#### **Real Filesystem in Test Hooks**

```javascript
// ❌ FORBIDDEN - Real I/O in test setup/teardown
beforeEach(async () => {
  await mkdir(testDir, { recursive: true }); // Race condition!
  await writeFile(testFile, "data"); // Filesystem conflict!
});

afterEach(async () => {
  await rmSync(testDir, { recursive: true }); // Cleanup race condition!
});
```

### **Comprehensive Detection Patterns**

The ESLint rule should detect:

#### **1. Filesystem Operations**

- `fs.*` and `fs/promises.*` usage
- `tmpdir()` calls
- `process.cwd()` for temp path creation

#### **2. Global State Anti-Patterns**

- Variables declared outside `describe` blocks with counter patterns
- `++` operators on global variables in `beforeEach`/`afterEach`
- Global `let` declarations with names like `*Counter`, `*Sequence`, `*Number`

#### **3. Non-Deterministic Uniqueness**

- `Date.now()` usage in path creation within test files
- `Math.random()` for "unique" identifiers in tests
- Timestamp-based directory/file naming patterns

#### **4. Problematic Import Patterns**

- Dynamic `import()` statements in test files
- `require()` calls inside test functions (not at module level)
- Conditional imports based on test state

#### **5. Dangerous Test Hook Patterns**

- Real filesystem operations in `beforeEach`/`afterEach`/`beforeAll`/`afterAll`
- Async operations that modify shared resources
- Global state mutations in test hooks

### **Enhanced Error Messages**

The rule should provide specific, actionable error messages:

```
"Global counter 'testSequenceNumber' detected in test file. Use test-scoped variables or mocks instead."

"Date.now() used for 'unique' path creation. This causes race conditions in parallel tests. Use mock paths like '/mock/test-123' instead."

"Dynamic import() detected in test file. Use static imports to prevent infinite loops and timing issues."

"Real filesystem operation 'mkdirSync' in beforeEach hook. Use mock.module() to mock filesystem operations instead."

"tmpdir() usage detected. Use fixed mock directories like '/mock/tmp' to prevent race conditions."
```

### **Rule Configuration Options**

```javascript
{
  "rules": {
    "no-test-interference": [
      "error",
      {
        "allowedModules": ["mock"], // modules that CAN import fs for mocking
        "testPatterns": ["**/*.test.ts", "**/tests/**"],
        "strictMode": true, // fails on ANY problematic pattern
        "allowTimestamps": false, // whether Date.now() is ever allowed
        "allowGlobalCounters": false, // whether global counters are allowed
        "allowDynamicImports": false, // whether dynamic imports are allowed
      }
    ]
  }
}
```

### Success Criteria

1. ESLint rule detects and prevents real filesystem operations in tests
2. Rule integrated into project ESLint configuration
3. Clear error messages with mocking alternatives
4. Prevents the exact patterns that caused issues in Task 176

This directly addresses the root cause of test failures in Task 176 and prevents future filesystem race conditions.

## 🆕 **NEW REQUIREMENTS ADDED (Post-Task Start)**

**📋 CONTEXT**: Following systematic test fixing that achieved 100% test success rate, we discovered the need for automated prevention of test anti-patterns beyond filesystem operations. This extends Task #332's scope to include comprehensive test architecture pattern enforcement.

### **EXTENSION: Additional Test Anti-Pattern Detection**

**🎯 Objective**: Extend the ESLint rule approach to include broader test architecture patterns, preventing regression of test anti-patterns that caused reliability issues.

**📊 Background**: During test fixing, we identified critical anti-patterns beyond filesystem operations:
- Global module mocks causing cross-test interference
- Unreliable factory-generated mocks
- CLI execution in unit tests (architectural violation)
- Magic string duplication in tests

**🛠️ Proposed Extensions**:

1. **Pre-commit Hook Enhancement**
   - Add checks for global `mock.module()` usage
   - Add warnings for `createMockTaskService(async ...)` patterns
   - Add verification that tests call domain functions (not CLI)
   - Extend existing secret scanning with test pattern validation

2. **ESLint Rule Expansion**
   - Extend existing `no-jest-patterns` rule to catch test anti-patterns
   - Add warnings for global module mocking outside test-utils
   - Detect CLI execution patterns in test files (`execAsync.*cli.ts`)
   - Add automatic suggestions for proper patterns

3. **Development Workflow Integration**
   - Integrate pattern checks into existing lint workflow
   - Add test architecture verification to CI/CD pipeline
   - Create automated suggestions for pattern improvements
   - Extend existing quality gates with test reliability checks

**📋 Implementation Plan**:

1. **Phase 1**: Extend existing pre-commit hooks with test pattern checks
2. **Phase 2**: Enhance `no-jest-patterns` ESLint rule with anti-pattern detection
3. **Phase 3**: Integrate into CI/CD pipeline for continuous monitoring
4. **Phase 4**: Create automated pattern improvement suggestions

**✅ Success Criteria** (Added to Task #332):
- [ ] Pre-commit hooks prevent global module mock usage
- [ ] ESLint rules catch and suggest fixes for test anti-patterns
- [ ] CI/CD pipeline validates test architecture patterns
- [ ] Developer workflow includes test pattern guidance
- [ ] Zero regression of identified test anti-patterns

**🔗 Approach**: Treat as separate concerns from filesystem operations - enhance existing `no-jest-patterns` rule rather than expanding the `no-real-fs-in-tests` rule.

**⏱️ Estimated Addition**: 1-2 weeks additional work integrated with existing Task #332 completion timeline.

## Requirements

## Solution

## Notes
