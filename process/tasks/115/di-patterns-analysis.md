# DI Patterns Analysis - Task 115

## Successful Patterns from Task 114 Migrations

### Pattern 1: Manual Dependency Injection

**Used in:** `session-update.test.ts`, domain tests
**Pattern:**

```typescript
// Manual mock creation in beforeEach
beforeEach(() => {
  mockGitService = {
    getSessionWorkdir: createMock(() => "/mock/session/workdir"),
    execInRepository: createMock(() => ""),
    stashChanges: createMock(() => Promise.resolve()),
    // ... other methods
  };

  mockSessionProvider = {
    getSession: createMock(() =>
      Promise.resolve({
        /* mock data */
      })
    ),
  };
});

// Function accepts dependencies as parameter
await updateSessionFromParams(params, {
  sessionDB: mockSessionProvider,
  gitService: mockGitService,
  getCurrentSession: mockGetCurrentSession,
});
```

**What works well:**

- Explicit control over dependencies
- Easy to customize per test
- Type-safe with proper interfaces
- Clear test intentions

### Pattern 2: Spy-Based Testing

**Used in:** `tasks.test.ts`, adapter tests
**Pattern:**

```typescript
let getTaskStatusSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  getTaskStatusSpy = spyOn(tasksDomain, "getTaskStatusFromParams").mockImplementation(() =>
    Promise.resolve("TODO")
  );
});

afterEach(() => {
  mock.restore();
});
```

**What works well:**

- Tests integration points without full DI
- Good for testing adapters/command handlers
- Simple setup for module-level testing

### Pattern 3: Utility-Based DI

**Used in:** `enhanced-utils.test.ts`, utility tests
**Pattern:**

```typescript
// Use helper functions for common scenarios
const deps = createTestDeps({
  sessionDB: {
    getSession: createMock(() =>
      Promise.resolve({
        /* override */
      })
    ),
  },
});

// Temporary overrides for specific tests
const result = withMockedDeps(originalDeps, overrides, testFunction);
```

**What works well:**

- Reduces boilerplate for common scenarios
- Consistent dependency structure
- Easy composition and overrides

## Current Gaps & Opportunities

### Gap 1: Common Test Scenarios Not Covered

**What's missing:** Helper functions for very common domain scenarios

**Examples needed:**

- "Clean git repo" scenario setup
- "Task with specific status" scenario setup
- "Session with conflicts" scenario setup

### Gap 2: Quick Setup Functions

**What's missing:** One-line setup for common test types

**Current:**

```typescript
// Too much boilerplate for simple scenarios
const deps = createTestDeps({
  taskService: {
    getTask: createMock(() => Promise.resolve(createTaskData({ status: "TODO" }))),
  },
});
```

**Could be:**

```typescript
// Simpler for common cases
const deps = createTestDepsWithTask({ status: "TODO" });
```

### Gap 3: Test Pattern Documentation

**What's missing:** Quick reference for "which pattern to use when"

**Needed:**

- Decision tree: Manual DI vs Spy vs Utility-based
- Common recipes for different test types
- Migration examples from old to new patterns

## Small, Practical Improvements

### Improvement 1: Scenario Helpers (1-2 hours)

Add functions like:

- `createCleanGitDeps()` - Git service that reports clean status
- `createTaskDepsWithStatus(status)` - Task service with task in specific status
- `createConflictingSessionDeps()` - Session update with merge conflicts

### Improvement 2: Quick Setup Functions (1-2 hours)

Add convenience functions:

- `setupDomainTest()` - Common setup for domain function tests
- `setupAdapterTest()` - Common setup for adapter/command tests
- `setupIntegrationTest()` - Common setup for integration tests

### Improvement 3: Pattern Decision Guide (1 hour)

Create simple documentation:

- When to use Manual DI (complex domain logic)
- When to use Spies (adapter/integration tests)
- When to use Utility helpers (simple unit tests)

## Validation Strategy

1. **Test the improvements** on 2-3 existing test files
2. **Measure reduction in boilerplate** (lines of setup code)
3. **Get developer feedback** on ease of use
4. **Ensure backward compatibility** with existing patterns

## Implementation Priority

1. **Document patterns first** (highest value, lowest risk)
2. **Add scenario helpers** (immediate developer value)
3. **Add quick setup functions** (nice-to-have improvements)
