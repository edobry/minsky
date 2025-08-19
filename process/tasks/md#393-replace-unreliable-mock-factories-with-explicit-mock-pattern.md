# Replace Unreliable Mock Factories with Explicit Mock Pattern

## Context

## Overview

**HIGH PRIORITY**: Replace unreliable factory mock patterns with explicit mock patterns that have achieved 100% test success rate.

## Problem Statement

Multiple test files use unreliable factory mock patterns that create unpredictable test behavior:

- **Primary Target**: `taskCommands.test.ts` has 6 instances of unreliable patterns
- **Pattern**: `createMock(() => Promise.resolve(...))` and similar factory-based mocking
- **Risk**: Unpredictable return values and timing issues
- **Evidence**: ESLint warnings indicate these patterns detected across codebase

## Discovery Evidence

From 100% test success analysis:

- Factory mock patterns create unpredictable test execution
- Explicit mock patterns with fixed return values achieve consistent results
- The proven pattern that eliminated test failures uses explicit mock definitions

## Unreliable Patterns to Replace

### Pattern 1: Factory-based Promise Mocks

```typescript
// ❌ UNRELIABLE
createMock(() => Promise.resolve(someValue))
createMock(async () => false)
createMock(() => Promise.reject(new Error(...)))
```

### Pattern 2: Dynamic Factory Functions

```typescript
// ❌ UNRELIABLE
createMock((id: unknown) => {
  const task = tasks.find((t) => t.id === id);
  return task || null;
});
```

### Pattern 3: Complex Factory Patterns

```typescript
// ❌ UNRELIABLE
createMock(async (options: any) => {
  // Complex logic here
  return { ... };
})
```

## Proven Replacement Pattern

**TO (Reliable):**

```typescript
// ✅ EXPLICIT - Fixed return values
const mockTaskService = {
  getTasks: mock().mockResolvedValue([mockTask1, mockTask2]),
  getTask: mock().mockResolvedValue(mockTask1),
  createTask: mock().mockResolvedValue(createdTask),
};
```

## Implementation Plan

### Phase 1: `taskCommands.test.ts` (6 instances)

1. Identify all 6 unreliable factory patterns in the file
2. Replace with explicit mock pattern used in successful tests
3. Verify test passes in isolation and full suite
4. Document the transformation pattern

### Phase 2: Systematic Replacement

1. **Session Tests**: `session-*-test.ts` files with factory patterns
2. **Domain Tests**: Other domain function tests with factory patterns
3. **Integration Tests**: Any integration tests using factory patterns

### Phase 3: Prevention

1. Add ESLint rule to prevent factory mock patterns
2. Update test architecture documentation
3. Create explicit mock examples for common patterns

## Success Criteria

- [ ] All 6 instances in `taskCommands.test.ts` replaced with explicit patterns
- [ ] Zero unreliable factory mock patterns remain in test suite
- [ ] All affected tests pass individually AND in full suite
- [ ] Explicit mock pattern documented and enforced
- [ ] Test execution remains predictable and deterministic

## Files to Target (Priority Order)

### Critical:

1. `src/domain/tasks/taskCommands.test.ts` (6 instances - highest concentration)

### High Priority:

2. `src/domain/session-lookup-bug-reproduction.test.ts` (multiple instances)
3. `src/domain/session-pr-no-branch-switch.test.ts`
4. `src/domain/session-approve.test.ts`

### Medium Priority:

5. `src/domain/tasks-core-functions.test.ts`
6. `src/domain/tasks-interface-commands.test.ts`
7. Other files with factory mock patterns

## Reference Implementation

The successful pattern from 100% test success implementation:

- Use explicit mock objects with fixed return values
- Avoid dynamic factory functions that compute return values
- Prefer `mock().mockResolvedValue(fixedValue)` over `createMock(() => ...)`
- Ensure mock data exactly matches real system output formats

## Notes

- This directly implements the proven patterns from 100% test success achievement
- Focus on deterministic, predictable test behavior
- Pattern here should prevent future unreliable mock introductions

## ⚠️ COORDINATION NOTE: Revisit Required

**IMPORTANT**: This task needs to be revisited and potentially coordinated with related test infrastructure tasks:

- **md#397**: Continue Systematic ESLint-Guided Filesystem Violation Fixes
  - Focuses on eliminating real filesystem operations in tests
  - Uses dependency injection patterns and mock filesystem operations
  - May conflict or overlap with mock factory patterns in this task

- **md#414**: Fix post-merge test regressions after md#397 merge
  - Addresses test failures introduced by filesystem violation fixes
  - Involves logger API, session DB I/O, and validation messaging changes
  - May have changed the mock patterns that this task targets

- **md#115**: Implement Dependency Injection Test Patterns (DONE)
  - Established dependency injection patterns for test isolation
  - May provide foundation patterns that supersede the factory mock approach

- **md#176**: Comprehensive Session Database Architecture Fix (DONE)
  - Implemented universal DI patterns and perfect test isolation
  - Likely established proven mock patterns that should be used consistently

**ACTION REQUIRED**: Before continuing with md#393, review the current state of:
1. Mock patterns established by md#115 and md#176
2. ESLint filesystem violation fixes from md#397
3. Any test regression fixes from md#414
4. Ensure md#393 patterns align with and don't conflict with these efforts

**POTENTIAL CONSOLIDATION**: Consider whether md#393 should be merged into md#397 or md#414, or whether the mock factory patterns are already addressed by the DI patterns from md#115/md#176.

## Requirements

## Solution

## Notes
