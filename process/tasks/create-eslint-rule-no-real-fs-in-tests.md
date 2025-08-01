# Task: Create ESLint rule to forbid real filesystem operations in tests

## Problem Statement

During Task 176, we discovered multiple test files using real filesystem operations causing:

- **Race conditions** between concurrent test runs
- **Test interference** where tests pass individually but fail in test suite
- **Infinite loops** due to filesystem conflicts (1.6+ billion ms timeouts)
- **Non-deterministic test behavior**

## Examples of Problematic Patterns We Fixed

### 1. JsonFileTaskBackend Test

**Before:** Used real temp directories with `mkdirSync`, `rmSync`, global counters
**After:** Pure in-memory mocking with `Map<string, any>`

### 2. Session File Move Tools Test

**Before:** `writeFileSync`, `mkdirSync`, `rmSync` with temp directories
**After:** Complete mocking elimination of all filesystem operations

### 3. Session PR Body Path Test

**Before:** Real file I/O with `writeFile`, `readFile`, `mkdir`, `rm`
**After:** Simulated file content without actual filesystem operations

## Required ESLint Rule Implementation

### Rule Location

- `src/eslint-rules/no-real-fs-in-tests.js`

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

### Test File Detection Patterns

The rule should detect test files by:

- File patterns: `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`
- Directory patterns: `tests/`, `__tests__/`, `test/`
- Files importing test frameworks: `bun:test`, `jest`, `mocha`, `vitest`

### Allowed Alternatives (Should NOT trigger rule)

```javascript
// ✅ ALLOWED - Mock implementations
mock.module("fs", () => ({ ... }));
mock.module("fs/promises", () => ({ ... }));

// ✅ ALLOWED - In-memory data structures
const mockTasks = new Map<string, any>();

// ✅ ALLOWED - Dependency injection with mocked storage
const backend = { async createTaskData(task) { ... } };
```

### Error Messages

The rule should provide clear, actionable error messages:

```
"Real filesystem operations are forbidden in tests. Use mocks or in-memory storage instead."

"Import 'fs' module is not allowed in test files. Use mock.module() to mock filesystem operations."

"Function 'mkdirSync' from 'fs' is not allowed in tests. Create in-memory test data instead."

"Avoid 'tmpdir()' in tests. Use mock paths like '/mock/test-dir' instead."
```

### Rule Configuration Options

```javascript
{
  "rules": {
    "no-real-fs-in-tests": [
      "error",
      {
        "allowedModules": ["mock"], // modules that CAN import fs for mocking
        "testPatterns": ["**/*.test.ts", "**/tests/**"],
        "strictMode": true // fails on ANY fs import, not just usage
      }
    ]
  }
}
```

## Implementation Requirements

### Core Rule Logic

1. **Detect test files** using patterns and imports
2. **Parse AST** to find filesystem imports and usage
3. **Report violations** with specific error messages
4. **Suggest alternatives** in error messages

### Integration Requirements

1. Add rule to main ESLint configuration
2. Update `.eslintrc.js` to include the rule
3. Add rule to pre-commit hooks
4. Document rule in project ESLint documentation

### Testing the Rule

Create test cases for the ESLint rule itself:

```javascript
// Valid test cases (should not trigger rule)
- Pure mocking patterns
- In-memory test data
- Dependency injection

// Invalid test cases (should trigger rule)
- Real fs imports
- Temp directory creation
- File system operations in beforeEach/afterEach
```

## Success Criteria

1. ✅ ESLint rule detects and prevents real filesystem operations in tests
2. ✅ Rule integrated into project ESLint configuration
3. ✅ All existing test files pass the new rule (after violations are fixed)
4. ✅ Clear documentation with examples of correct mocking patterns
5. ✅ Rule catches the specific patterns that caused issues in Task 176
6. ✅ Rule provides helpful error messages with alternatives
7. ✅ Rule can be configured for different strictness levels

## Expected Impact

### Prevention of Future Issues

- **Zero race conditions** from filesystem conflicts
- **Deterministic test behavior** across all environments
- **Faster test execution** (in-memory vs disk I/O)
- **Better test isolation** (no shared filesystem state)

### Developer Experience

- **Clear guidance** on proper test patterns
- **Immediate feedback** via ESLint during development
- **Consistent testing patterns** across the codebase
- **Prevention of infinite loop timeouts** we experienced

## Background Context

This rule prevents the exact test architecture problems we fixed in Task 176:

- `jsonFileTaskBackend.test.ts` - Race conditions with shared temp directories
- `session-file-move-tools.test.ts` - Filesystem conflicts causing infinite loops
- `session-pr-body-path-refresh-bug.test.ts` - Real I/O causing timeouts

The solution enforces **pure mocking** and **in-memory testing** patterns that eliminate filesystem dependencies entirely.

## Priority: HIGH

This task directly addresses the root cause of test failures that blocked Task 176 completion and will prevent similar issues in future development.
