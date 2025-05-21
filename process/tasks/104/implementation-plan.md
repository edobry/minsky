# Implementation Plan for Task #104: Re-implement Disabled Integration Tests

## Overview

This plan outlines the approach for re-implementing the disabled integration tests in the Minsky codebase. These tests were temporarily disabled due to issues with mocking and test framework compatibility, resulting in placeholder tests that always pass. With the completion of tasks #101-#103, we now have the foundation to properly re-implement these tests.

## Affected Test Files

1. `src/adapters/__tests__/integration/workspace.test.ts`
2. `src/adapters/__tests__/integration/git.test.ts`
3. `src/domain/__tests__/github-backend.test.ts`
4. `src/domain/__tests__/github-basic.test.ts`
5. `src/adapters/__tests__/cli/session.test.ts`
6. `src/adapters/__tests__/cli/tasks.test.ts`

## Implementation Strategy

### Phase 1: Analysis and Preparation (1 day)

1. **Review the original test implementations**

   - Examine git history to find the original test contents before they were disabled
   - Identify specific mocking patterns that caused issues
   - Document test coverage intentions for each file

2. **Review task #101-#103 improvements**

   - Study the new dependency injection patterns from task #101
   - Understand the functional patterns from task #102 (and subtasks #106-#108)
   - Explore the enhanced test utilities from task #103

3. **Define test coverage goals**
   - Ensure at least the same coverage as the original tests
   - Identify opportunities for expanded coverage

### Phase 2: Test Re-implementation (3-4 days)

#### Workspace Integration Tests (1 day)

- Re-implement `workspace.test.ts` using dependency injection for:
  - `isSessionRepository`
  - `getSessionFromRepo`
  - `getCurrentSession`
  - `resolveWorkspacePath`
- Utilize test utilities from task #103 for mocking filesystem operations
- Properly isolate tests from the actual filesystem

#### Git Integration Tests (1 day)

- Re-implement `git.test.ts` using:
  - Isolated test environment
  - Mocked git command execution
  - Clean test context management
- Apply functional patterns from task #107

#### GitHub Backend Tests (1 day)

- Re-implement `github-backend.test.ts` and `github-basic.test.ts`:
  - Mock external API calls
  - Isolate from environment variables
  - Use dependency injection for services

#### CLI Adapter Tests (1 day)

- Re-implement `session.test.ts` and `tasks.test.ts`:
  - Use proper command execution simulation
  - Mock user input consistently
  - Verify outputs through interfaces rather than direct console capture

### Phase 3: Test Verification and Cleanup (1 day)

1. **Ensure proper test isolation**

   - Verify tests don't affect each other
   - Confirm no remaining test pollution

2. **Code review and refactoring**

   - Apply consistent patterns across all test files
   - Extract common test setup code to shared utilities if needed

3. **Documentation**

   - Add detailed comments explaining test patterns
   - Update related documentation if necessary

4. **Coverage analysis**
   - Run coverage reports to verify test coverage
   - Address any coverage gaps

## File-by-File Implementation Details

### 1. `workspace.test.ts` Implementation

```typescript
// Mock examples
const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
  getCwd: () => "/mock/path",
  pathExists: async (path) => true,
  // other methods as needed
});

// Test examples
test("isSessionRepository should correctly identify session repos", async () => {
  // Test with dependency injection
  const result = await isSessionRepository("/mock/path", { workspaceUtils: mockWorkspaceUtils });
  expect(result).toBe(true);
});
```

### 2. `git.test.ts` Implementation

```typescript
// Test context setup
const testContext = createTestContext();
beforeEach(() => {
  testContext.setUp({
    mockGitService: createPartialMock<GitServiceInterface>({
      // Git service mocks
    }),
  });
});
afterEach(() => testContext.tearDown());

// Test examples
test("git operations should handle errors gracefully", async () => {
  // Test implementation using mocked dependencies
});
```

### 3. `github-backend.test.ts` Implementation

```typescript
// Mock examples
const mockGitHubAPI = mockFunction<typeof fetch>().mockResolvedValue({
  json: async () => ({
    /* mock response */
  }),
  ok: true,
});

// Test examples
test("should create GitHub issue from task", async () => {
  // Test implementation using mocked GitHub API
});
```

### 4. CLI Adapter Tests Implementation

```typescript
// Mock examples
const mockStdout = createMockWritable();
const mockStdin = createMockReadable();

// Test examples
test("session list should output formatted session information", async () => {
  // Test with CLI output capture and verification
});
```

## Risks and Mitigations

1. **Risk**: Bun test framework might still have limitations with certain mocking patterns
   **Mitigation**: Create specialized utilities to work around Bun limitations

2. **Risk**: Some components might be difficult to test in isolation
   **Mitigation**: Consider refactoring hard-to-test components if necessary

3. **Risk**: Tests might become flaky if not properly isolated
   **Mitigation**: Use TestContext for proper resource cleanup between tests

## Success Criteria

1. All tests pass reliably without flakiness
2. No placeholder tests remain in the codebase
3. Test coverage meets or exceeds original coverage
4. All tests follow the patterns established in tasks #101-#103
5. Documentation is clear and comprehensive
