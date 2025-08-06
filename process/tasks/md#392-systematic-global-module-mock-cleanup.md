# Systematic Global Module Mock Cleanup

## Context

## Overview

**CRITICAL PRIORITY**: Fix cross-test interference caused by global `mock.module()` calls that persist across tests and cause random test failures.

## Problem Statement

Multiple test files use problematic global mocking patterns that create test isolation failures:

- **15+ files** with risky global `mock.module()` calls
- **Cross-test interference**: Tests pass in isolation but fail in full suite
- **Random failures**: Global state pollution affects unrelated tests
- **Session-related tests** have highest interference risk

## Discovery Evidence

From 100% test success analysis:
- Global `mock.module()` calls persist across tests causing interference
- Tests passing individually but failing in full suite indicates cross-test pollution
- Functions importing mocked modules fail when other tests globally mock same modules

## Solution Approach

### Priority 1: Session-Related Tests (Highest Risk)
Target files with session operations first as they have highest interference potential:

1. `src/domain/session-*.test.ts` files
2. `tests/adapters/cli/session*.test.ts` files
3. `src/domain/session/session-*.test.ts` files

### Priority 2: Repository Backend Tests
4. Files with `repository` or `backend` in the name
5. Task-related test files

### Pattern Transformation

**FROM (Dangerous):**
```typescript
mock.module("../utils/logger", () => ({
  log: mockLog,
}));
```

**TO (Safe):**
```typescript
const dependencies = {
  logger: mockLogger,
  database: mockDatabase,
};
```

## Implementation Steps

1. **Audit Phase**: Identify all files with global `mock.module()` calls
2. **Priority Mapping**: Categorize by interference risk level
3. **Pattern Migration**: Convert to dependency injection pattern
4. **Verification**: Ensure tests pass both individually and in full suite
5. **Documentation**: Update patterns in test architecture guide

## Success Criteria

- [ ] Zero global `mock.module()` calls in session-related tests
- [ ] All tests pass individually AND in full test suite
- [ ] No cross-test interference detected
- [ ] Dependency injection pattern consistently applied
- [ ] Test execution time not significantly increased

## Files to Target (Initial List)

### Critical (Session-related):
- `src/domain/session-approve*.test.ts`
- `src/domain/session-pr*.test.ts` 
- `src/domain/session-lookup*.test.ts`
- `tests/adapters/cli/session*.test.ts`

### High Priority:
- `src/domain/rules/rule-template-service.test.ts`
- `src/domain/rules/template-system.test.ts`
- `src/domain/storage/database-integrity-checker.test.ts`

## Notes

- This directly addresses the architectural anti-pattern identified in Critical Test Architecture Protocol
- Success here enables reliable test execution for all future development
- Pattern established here should be documented and enforced via ESLint rules

## Requirements

## Solution

## Notes
