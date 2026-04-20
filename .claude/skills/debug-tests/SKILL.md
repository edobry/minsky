---
name: debug-tests
description: >-
  Systematic debugging of test failures: categorize, isolate, fix by category.
  Use when tests are failing, debugging test issues, or encountering bun:test problems.
  Covers infinite loop detection, mock issues, variable naming traps, and category-by-category fixing.
user-invocable: true
---

# Debug Tests

Systematically debug test failures using a proven 8-step process. Fixes issues category-by-category rather than jumping between unrelated problems.

## Arguments

Optional: test file path, error message, or description of failures. If omitted, apply to the current test failures being discussed.

## Process

### 1. Categorize failures (CRITICAL FIRST STEP)

Before attempting any fixes, categorize every failure by type:

| Category | Symptoms |
|----------|----------|
| **Timeout/Infinite Loop** | Tests taking >30 seconds, timing out |
| **Variable Naming** | "X is not defined" errors, underscore prefix mismatches |
| **Mock Implementation** | Function signature mismatches, missing methods, `log.cli is not a function` |
| **Property Naming** | `_status` vs `status`, `_session` vs `session` property mismatches |
| **Data Structure** | Mock data not matching test expectations, object spread conflicts |

**Fix one category completely before moving to the next.** Never jump between different types of problems.

### 2. Isolate and verify

- Run the specific failing test file: `bun test path/to/file.test.ts`
- Use `test.only()` to focus on a specific case
- Verify fixes in isolation before testing with the full suite

### 3. Check for variable naming traps (CRITICAL)

**Variable naming mismatches can cause infinite test execution (4+ billion milliseconds).**

Root causes:
- Declaration/usage mismatch: `const _workspacePath = X` but code uses `workspacePath`
- Parameter/reference mismatch: function parameter `_workspacePath` but usage `workspacePath`
- Undefined variable references in loops or async operations

Detection: Tests running >30 seconds before timing out.

Decision tree:
1. Is the variable defined with underscore but used without? -> Remove underscore from **definition**, not usage
2. Is the variable intentionally unused? -> Only then is `_prefix` appropriate
3. Never rename used variables to underscore-prefixed

### 4. Fix mock implementation issues

Common patterns and solutions:

**Logger mock failures** (`log.cli is not a function`):
```typescript
import { createMockLogger } from "../utils/test-utils/logger-mock";
const mockLog = createMockLogger();
mockModule("../../../src/utils/logger", () => ({ log: mockLog }));
```

**Missing mock methods**: Define all methods explicitly rather than using factory functions.

**Cross-test interference**: If tests pass in isolation but fail in suite, look for global `mock.module()` calls persisting across tests. Fix: use dependency injection instead.

### 5. Verify framework setup

- Check imports for completeness and correctness
- Verify mock setup follows established patterns
- Review cleanup procedures in `afterEach` blocks

### 6. Analyze errors by type

- **Type errors**: Check import issues or framework API mismatches
- **Runtime errors**: Examine stack traces for mock setup issues
- **Assertion failures**: Compare expected vs actual values
- **Timeout errors**: Check for variable naming mismatches causing infinite loops

### 7. Fix category-by-category

Proven methodology (from Task #224):

**Phase 1 — Critical Timeouts**: Identify infinite loop sources (often variable naming). Fix declaration/usage mismatches. Verify execution time improvements.

**Phase 2 — Variable Naming**: Apply the decision tree from step 3 systematically. Fix `_result`/`_options`/`_session` pattern mismatches. Update property references.

**Phase 3 — Mock Implementation**: Add missing functions to mocks. Fix function signature mismatches. Update type definitions.

**Phase 4 — Data Structure Alignment**: Fix mock data to match test expectations. Resolve object spread conflicts. Update property names in test data.

### 8. Track progress quantitatively

Track specific metrics, not vague descriptions:
- Tests passing per category: "Rules Integration: 15/15 passing"
- Overall success rates: "Integration tests: 42/45 passing (93%)"
- Performance improvements: "4.3B ms -> 241ms execution time"

## Common bun:test issues

| Issue | Solution |
|-------|----------|
| `mock.fn is not a function` | Use `jest.fn()` instead |
| `mock.restoreAll is not a function` | Use `mock.restore()` |
| `log.cli is not a function` | Use `createMockLogger()` from logger-mock.ts |
| Tests timeout after 30+ seconds | Check for variable naming mismatches |
| "X is not defined" errors | Apply variable naming decision tree (step 3) |
| Property access errors | Check `_property` vs `property` naming |
| Tests pass alone, fail in suite | Hunt down global `mock.module()` calls |

## Verification protocol

After debugging, verify in this order:

1. **Isolation**: Specific test file passes alone
2. **Category**: All tests in same category pass
3. **Integration**: Fixes don't break other test categories
4. **Performance**: No infinite loops (execution <30 seconds)
5. **Full suite**: `bun test` passes completely

## Key principles

- **Categorize before fixing.** Random fix attempts waste time and mask root causes.
- **One category at a time.** Mixing fix types leads to regression whack-a-mole.
- **Variable naming kills silently.** A `_` prefix mismatch can cause infinite loops, not just "undefined" errors.
- **Track with numbers, not words.** "Better" means nothing; "42/45 passing" means everything.
- **Root cause over symptom masking.** Don't add `setupTestMocks()` to paper over cross-test interference — find and remove the global mock.
