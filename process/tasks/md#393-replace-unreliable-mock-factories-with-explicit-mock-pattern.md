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

## Requirements

## Solution

## Notes
