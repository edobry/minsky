---
name: fix-skipped-tests
description: >-
  Fix or remove skipped tests: zero tolerance for .skip(), test.todo(), or
  placeholder assertions. Use when encountering skipped tests, placeholder tests,
  or when asked to clean up the test suite.
user-invocable: true
---

# Fix Skipped Tests

Zero-tolerance enforcement for skipped and placeholder tests. Every test must pass or be deleted.

## Arguments

Optional: file path or pattern (e.g., `/fix-skipped-tests src/domain/`). If omitted, scans the full test suite.

## Process

### 1. Identify skipped tests

Search for:

- `test.skip(` / `it.skip(` / `describe.skip(`
- `test.todo(` / `it.todo(`
- `expect(true).toBe(true)` or similar placeholder assertions
- `// @ts-ignore` hiding test failures

### 2. Investigate the reason

For each skipped test, determine why it was skipped:

- **Real operations**: Test uses filesystem, git, network, or database directly
- **Integration complexity**: Test depends on external services
- **Legacy code**: Test covers code that may be obsolete
- **"Too complex"**: Someone gave up

### 3. Fix or delete

| Reason                 | Action                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Real operations        | Mock with dependency injection — use `createMock()`, `createMockLogger()`, `createMockFileSystem()` |
| Integration complexity | Mock external dependencies, break into smaller testable units                                       |
| Obsolete code          | Delete the test AND the dead code it tests                                                          |
| "Too complex"          | Break down into manageable steps and fix. Complexity is never a valid reason to skip.               |

### 4. Verify

- Run the specific test file: `bun test path/to/file.test.ts`
- Run the full test suite to check for regressions
- Confirm zero skipped tests remain

## The "too complex" violation

**NEVER claim any test is "too complex to fix."**

When facing a complex test:

1. **Reject the premise** — no problem is too complex to decompose
2. **Break it down** — identify the specific dependency or setup that's difficult
3. **Fix incrementally** — mock one dependency at a time
4. **Verify** — run after each change

Approaches for common "complex" scenarios:

- **Command registry issues** → Mock the command registry
- **Complex dependencies** → Use dependency injection
- **Integration complexity** → Break into isolated unit tests
- **Setup complexity** → Create proper test fixtures and helpers

## Key principles

- **A skipped test is a broken test we're ignoring.** It provides zero value and false confidence.
- **Every test must pass or the code it tests must not exist.** No middle ground.
- **Complexity is not an excuse.** Break down, mock, inject, fix.
- **Delete is better than skip.** If a test is truly obsolete, remove it entirely.
