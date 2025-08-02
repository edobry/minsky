# Task: Fix Remaining Test Failures - Comprehensive Guide

## Overview

This task provides step-by-step guidance for fixing the remaining ~65 failing tests using the patterns and techniques established during the Task 176 qualified ID migration. The failures follow predictable patterns that can be systematically addressed.

## Context

After merging Task 176 (qualified task ID system), we implemented a "permissive in, strict out" architecture where:
- **Input**: Accept various formats (`"283"`, `"#283"`, `"task#283"`, `"md#367"`)
- **Internal**: Always use qualified format (`"md#283"`, `"gh#367"`)
- **Output**: Display qualified format consistently

Additional improvements include:
- **Session naming**: Use `task-md#001` (with hyphen) instead of `taskmd#001`
- **Dependency Injection**: Proper DI for testability
- **Test maintainability**: Constants and clean mock patterns

## Key Patterns & Techniques Learned

### 1. Task ID Format Migration Pattern

**Problem**: Tests expect legacy formats but code returns qualified formats

**Solution Steps**:
```typescript
// ❌ Old expectation
expect(result.taskId).toBe("265");
expect(result.session).toBe("task265");

// ✅ New expectation  
expect(result.taskId).toBe("md#265");
expect(result.session).toBe("task-md#265");
```

**Diagnostic**: Look for errors like:
- `Expected: "265", Received: "md#265"`
- `Expected: "task265", Received: "task-md#265"`

### 2. Session Naming Consistency Pattern

**Problem**: Direct string concatenation vs proper naming function

**Solution Steps**:
```typescript
// ❌ Old direct concatenation
sessionName = `task${taskId}`;

// ✅ New proper function
import { taskIdToSessionName } from "./tasks/unified-task-id";
sessionName = taskIdToSessionName(taskId);
```

**Result**: Ensures hyphen separator (`task-md#001` not `taskmd#001`)

### 3. Dependency Injection (DI) Fixes Pattern

**Problem**: Functions not accepting dependencies, tests can't inject mocks

**Solution Steps**:
1. **Function signature**: Add `deps` parameter
```typescript
// ❌ Old
export async function approveSession(params: ApproveParams): Promise<Result> {
  const sessionDB = createSessionProvider(); // Hard dependency!

// ✅ New  
export async function approveSession(
  params: ApproveParams, 
  deps?: { sessionDB?: SessionProviderInterface }
): Promise<Result> {
  const sessionDB = deps?.sessionDB || createSessionProvider();
```

2. **Test usage**: Provide mocks via DI
```typescript
// ❌ Old spy approach (brittle)
const spy = jest.spyOn(module, 'createSessionProvider');

// ✅ New DI approach (robust)
const mockSessionDB = { getSession: mock(() => sessionRecord) };
const result = await approveSession(params, { sessionDB: mockSessionDB });
```

### 4. Mock Data Completeness Pattern

**Problem**: Tests fail because mock data missing required properties

**Solution Steps**:
1. **Check error**: `undefined` or missing property errors
2. **Add missing properties**:
```typescript
// ❌ Old incomplete mock
const mockSession = { session: "test", taskId: "md#265" };

// ✅ New complete mock
const mockSession = {
  session: "test-session",
  taskId: "md#265", 
  prBranch: "pr/test-session",    // Often missing!
  commitHash: "abc123def456",     // Often missing!
  createdAt: new Date().toISOString(),
  repoUrl: "test/repo"
};
```

### 5. Test Constants & Maintainability Pattern

**Problem**: Magic strings and duplication create maintenance burden

**Solution Steps**:
1. **Extract base constants**:
```typescript
// ✅ Base constants
const TEST_SESSION_NAME = "test-session";
const TEST_TASK_ID = "265";
const TEST_REPO_PATH = "/test/repo/path";
```

2. **Derive related constants** (avoid duplication):
```typescript
// ✅ Derived constants
const TEST_PR_BRANCH = `pr/${TEST_SESSION_NAME}`;
const TEST_REVIEW_ID = `test-review-${TEST_TASK_ID}`;
const TEST_QUALIFIED_TASK_ID = `md#${TEST_TASK_ID}`;
const TEST_SESSION_WITH_TASK = `task-${TEST_QUALIFIED_TASK_ID}`;
```

## Systematic Fixing Approach

### Step 1: Identify Failure Pattern
Run individual test files to see specific errors:
```bash
bun test ./path/to/failing-test.ts --timeout 5000
```

### Step 2: Classify the Error
- **Format Mismatch**: `Expected: "265", Received: "md#265"`  
- **Session Naming**: `Expected: "task265", Received: "task-md#265"`
- **Missing Mock Property**: `undefined` or property access errors
- **DI Issue**: `ResourceNotFoundError` despite providing mocks
- **Magic String Issue**: Hard to maintain repeated strings

### Step 3: Apply Appropriate Pattern
Use the patterns above based on error classification.

### Step 4: Test & Verify
```bash
bun test ./path/to/fixed-test.ts --timeout 5000
```

### Step 5: Commit Incrementally
```bash
git add . 
git commit -m "fix: [specific test file] - [pattern applied]

- [Brief description of changes]
- [Pattern used]
- [Tests now passing]"
```

## Common Failing Test Categories

### A. Session Approve Tests
**Issues**: Session name format mismatches, DI problems
**Files**: `session-approve.test.ts`, `session-approve-branch-cleanup.test.ts`
**Pattern**: Apply DI + Constants + Format Migration

### B. PR State Optimization  
**Issues**: Missing mock properties (`commitHash`), undefined returns
**Files**: `session-pr-state-optimization.test.ts`
**Pattern**: Apply Mock Data Completeness

### C. Session Start Consistency
**Issues**: Session creation with new naming format
**Files**: Various session start test files
**Pattern**: Apply Session Naming Consistency

### D. Git Clone Regression
**Issues**: Qualified ID format expectations  
**Files**: `session-git-clone-bug-regression.test.ts`
**Pattern**: Apply Format Migration ✅ (Already Fixed)

## Debugging Techniques

### 1. Incremental Test Runs
```bash
# Test specific failing test
bun test ./src/domain/session-approve.test.ts -t "specific test name"

# Check overall progress
bun test 2>&1 | tail -5
```

### 2. Error Analysis
Look for these patterns in error messages:
- **Task ID format**: `"265"` vs `"md#265"`
- **Session format**: `"task265"` vs `"task-md#265"`  
- **Missing properties**: `undefined` in assertions
- **DI failures**: `ResourceNotFoundError` despite mocks

### 3. Mock Verification
Ensure mocks include all required properties by checking the actual domain code expectations.

## Success Metrics

- **Target**: Reduce failing tests from ~65 to <10
- **Maintain**: ~1365+ passing tests  
- **Quality**: Clean, maintainable test code with proper constants
- **Consistency**: All tests follow qualified ID format expectations

## Files Likely Needing Updates

Based on current failures:

### High Priority:
- `src/domain/session-approve.test.ts` 
- `src/domain/session-approve-branch-cleanup.test.ts`
- `src/domain/session-pr-state-optimization.test.ts`

### Medium Priority:
- Session start related test files
- Any remaining task ID format expectation mismatches
- Git integration tests with session naming

### Pattern Files (Reference):
- `src/domain/session-auto-task-creation.test.ts` ✅ (Fixed - good example)
- `src/domain/session-git-clone-bug-regression.test.ts` ✅ (Fixed - good example)

## Next Steps

1. **Start with Session Approve tests** (highest failure count)
2. **Apply DI pattern** to fix ResourceNotFoundError issues  
3. **Update task ID expectations** from legacy to qualified format
4. **Extract constants** to improve maintainability
5. **Test incrementally** and commit progress
6. **Document any new patterns** discovered during fixes

## Reference Commands

```bash
# Run all tests and get summary
bun test 2>&1 | tail -5

# Get list of failing tests  
bun test 2>&1 | grep "(fail)" | head -10

# Test specific file
bun test ./src/domain/[test-file].test.ts --timeout 5000

# Fix linting after changes
npm run lint -- --fix

# Commit progress
git add . && git commit -m "fix: [description]"
```

This systematic approach should efficiently resolve the remaining test failures while maintaining code quality and consistency.