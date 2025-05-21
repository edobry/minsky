# Workspace Test Implementation Plan

## Overview

This document outlines the specific approach for re-implementing the workspace integration tests using the new testing patterns established in tasks #101-#103. The original tests were disabled due to mocking issues in Bun, and we'll leverage the new dependency injection patterns to create more testable and reliable tests.

## Original Test Structure

The original `workspace.test.ts` tested the following key functions:

- `isSessionRepository`
- `getSessionFromRepo`
- `getCurrentSession`
- `resolveWorkspacePath`

The tests used problematic mocking patterns:
- Module mocking that is incompatible with Bun
- Direct mocking of functions rather than using dependency injection
- Lack of proper test isolation

## New Implementation Approach

### 1. Test Setup

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isSessionRepository,
  getSessionFromRepo,
  getCurrentSession,
  resolveWorkspacePath,
  type WorkspaceUtilsInterface
} from "../../../domain/workspace.js";
import {
  createPartialMock,
  createTestContext
} from "../../../utils/test-utils/mocking.js";
import { createTestDeps } from "../../../utils/test-utils/dependencies.js";

describe("Workspace Domain Methods", () => {
  // Create test context for managing test resources
  const testContext = createTestContext();
  
  // Create base test dependencies
  const baseDeps = createTestDeps({
    // Use partial mocks with only the necessary functions implemented
    workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
      getCwd: () => "/mock/cwd",
      pathExists: async () => true,
      isValidGitRepo: async () => true,
      execGitCommand: async () => ({ stdout: "mock output", stderr: "" }),
    }),
  });

  beforeEach(() => {
    testContext.setUp();
  });

  afterEach(() => {
    testContext.tearDown();
  });
  
  // Test implementations will go here
});
```

### 2. Test Implementation for isSessionRepository

```typescript
describe("isSessionRepository", () => {
  test("returns true for a path in a session repository", async () => {
    // Arrange
    const repoPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        execGitCommand: async () => ({ 
          stdout: "ref/heads/task#123", 
          stderr: "" 
        }),
        pathExists: async (path) => path.includes(".git"),
      }),
    };
    
    // Act
    const result = await isSessionRepository(repoPath, deps);
    
    // Assert
    expect(result).toBe(true);
  });

  test("returns false for a path not in a session repository", async () => {
    // Arrange
    const repoPath = "/Users/user/projects/non-session-repo";
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        execGitCommand: async () => ({ 
          stdout: "main", 
          stderr: "" 
        }),
        pathExists: async () => true,
      }),
    };
    
    // Act
    const result = await isSessionRepository(repoPath, deps);
    
    // Assert
    expect(result).toBe(false);
  });

  test("returns false when an error occurs during check", async () => {
    // Arrange
    const repoPath = "/invalid/path";
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        execGitCommand: async () => {
          throw new Error("Git command failed");
        },
      }),
    };
    
    // Act
    const result = await isSessionRepository(repoPath, deps);
    
    // Assert
    expect(result).toBe(false);
  });
});
```

### 3. Test Implementation for getSessionFromRepo

```typescript
describe("getSessionFromRepo", () => {
  test("gets session information for a valid session repository", async () => {
    // Arrange
    const repoPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
    const expectedResult = {
      session: "session-name",
      mainWorkspace: "https://github.com/org/repo.git"
    };
    
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        execGitCommand: async (cmd) => {
          if (cmd.includes("config --get remote.origin.url")) {
            return { stdout: "https://github.com/org/repo.git", stderr: "" };
          }
          if (cmd.includes("rev-parse --abbrev-ref HEAD")) {
            return { stdout: "task#123", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      }),
    };
    
    // Act
    const result = await getSessionFromRepo(repoPath, deps);
    
    // Assert
    expect(result).toEqual(expect.objectContaining(expectedResult));
  });
  
  // Add more test cases for getSessionFromRepo
});
```

### 4. Test Implementation for getCurrentSession

```typescript
describe("getCurrentSession", () => {
  test("returns session information when in a session directory", async () => {
    // Arrange
    const sessionPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        getCwd: () => sessionPath,
        execGitCommand: async (cmd) => {
          if (cmd.includes("config --get remote.origin.url")) {
            return { stdout: "https://github.com/org/repo.git", stderr: "" };
          }
          if (cmd.includes("rev-parse --abbrev-ref HEAD")) {
            return { stdout: "task#123", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        pathExists: async () => true,
        isValidGitRepo: async () => true,
      }),
    };
    
    // Act
    const result = await getCurrentSession(deps);
    
    // Assert
    expect(result).toEqual(
      expect.objectContaining({ session: "session-name" })
    );
  });
  
  // Add more test cases for getCurrentSession
});
```

### 5. Test Implementation for resolveWorkspacePath

```typescript
describe("resolveWorkspacePath", () => {
  test("resolves workspace path from session name", async () => {
    // Arrange
    const sessionName = "task#123";
    const options: WorkspaceResolutionOptions = { sessionName };
    const expectedPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/task#123";
    
    const deps = {
      ...baseDeps,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        ...baseDeps.workspaceUtils,
        resolveSessionPath: async (name) => `/Users/user/.local/state/minsky/git/repo-name/sessions/${name}`,
      }),
    };
    
    // Act
    const result = await resolveWorkspacePath(options, deps);
    
    // Assert
    expect(result).toBe(expectedPath);
  });
  
  // Add more test cases for resolveWorkspacePath
});
```

## Migration Strategy

1. Replace the placeholder test with the new test implementation
2. Use the new dependency injection patterns from task #101
3. Apply the enhanced test utilities from task #103
4. Ensure all tests are isolated using the test context management

## Testing Approach

1. Start by implementing a minimal test suite that verifies core functionality
2. Add more test cases to cover edge cases and error conditions
3. Ensure all tests are independent and can run in any order
4. Verify that tests pass consistently and are not flaky

## Next Steps

1. Review the domain interfaces implementation from task #101
2. Study the workspace module implementation to understand dependencies
3. Start the actual implementation by replacing the placeholder test
4. Once completed, follow the same pattern for the other test files 
