import { describe, test, expect } from "bun:test";
import { approveSessionFromParams } from "./session";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session Approve Branch Cleanup", () => {
  // Bug: Missing branch cleanup after successful merge
  // Current implementation doesn't clean up local branches after merge
  // Expected behavior: Delete both local PR branch and task branch after successful merge
  test("should delete local PR branch and task branch after successful merge", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name: string) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
      listSessions: createMock(() => Promise.resolve([])),
      addSession: createMock(() => Promise.resolve()),
      updateSession: createMock(() => Promise.resolve()),
      deleteSession: createMock(() => Promise.resolve(true)),
      getRepoPath: createMock(() => Promise.resolve("/test/repo/path")),
    };

    const gitCommands: string[] = [];
    const mockGitService = {
      execInRepository: createMock((workdir: string, command: string) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate that PR branch exists locally (not merged yet)
        if (command.includes("show-ref --verify --quiet refs/heads/pr/task#265")) {
          return Promise.resolve(""); // Success means branch exists
        }
        // Simulate merge-base check shows branch is NOT already merged
        if (command.includes("merge-base --is-ancestor")) {
          throw new Error("not an ancestor"); // Failure means not merged yet
        }
        // Simulate successful branch operations
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.resolve()),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
    };

    // Test the approval with newly approved session
    const result = await approveSessionFromParams(
      {
        session: "task#265",
      },
      testDeps
    );

    // Verify the merge was successful
    expect(result.commitHash).toBe("abcdef123456");
    expect(result.session).toBe("task#265");
    expect(result.isNewlyApproved).toBe(true);

    // BUG: These branch cleanup commands should be called but currently aren't
    // Should delete the local PR branch after successful merge
    expect(gitCommands).toContain("git branch -d pr/task#265");

    // Should delete the local task branch if it exists
    expect(gitCommands).toContain("git branch -d task#265");
  });

  test("should handle branch cleanup failures gracefully without failing the operation", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name: string) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
      listSessions: createMock(() => Promise.resolve([])),
      addSession: createMock(() => Promise.resolve()),
      updateSession: createMock(() => Promise.resolve()),
      deleteSession: createMock(() => Promise.resolve(true)),
      getRepoPath: createMock(() => Promise.resolve("/test/repo/path")),
    };

    const gitCommands: string[] = [];
    const mockGitService = {
      execInRepository: createMock((workdir: string, command: string) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate that PR branch exists locally (not merged yet)
        if (command.includes("show-ref --verify --quiet refs/heads/pr/task#265")) {
          return Promise.resolve(""); // Success means branch exists
        }
        // Simulate merge-base check shows branch is NOT already merged
        if (command.includes("merge-base --is-ancestor")) {
          throw new Error("not an ancestor"); // Failure means not merged yet
        }
        // Simulate branch deletion failures
        if (command.includes("branch -d")) {
          throw new Error("branch deletion failed - branch not found or has unmerged changes");
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.resolve()),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
    };

    // Test the approval - should not fail even if branch cleanup fails
    const result = await approveSessionFromParams(
      {
        session: "task#265",
      },
      testDeps
    );

    // Verify the merge was still successful despite cleanup failures
    expect(result.commitHash).toBe("abcdef123456");
    expect(result.session).toBe("task#265");
    expect(result.isNewlyApproved).toBe(true);

    // Verify cleanup was attempted
    expect(gitCommands).toContain("git branch -d pr/task#265");
    expect(gitCommands).toContain("git branch -d task#265");
  });

  test("should not attempt branch cleanup for already approved sessions", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name: string) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
      listSessions: createMock(() => Promise.resolve([])),
      addSession: createMock(() => Promise.resolve()),
      updateSession: createMock(() => Promise.resolve()),
      deleteSession: createMock(() => Promise.resolve(true)),
      getRepoPath: createMock(() => Promise.resolve("/test/repo/path")),
    };

    const gitCommands: string[] = [];
    const mockGitService = {
      execInRepository: createMock((workdir: string, command: string) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate that PR branch doesn't exist (already cleaned up)
        if (command.includes("show-ref --verify --quiet refs/heads/pr/task#265")) {
          throw new Error("branch doesn't exist");
        }
        // Simulate merge-base check shows branch is already merged
        if (command.includes("merge-base --is-ancestor")) {
          return Promise.resolve("");  // Success means it's already merged
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.resolve()),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
    };

    // Test the approval of already approved session
    const result = await approveSessionFromParams(
      {
        session: "task#265",
      },
      testDeps
    );

    // Verify this was detected as already approved
    expect(result.session).toBe("task#265");
    expect(result.isNewlyApproved).toBe(false);

    // Should NOT attempt branch cleanup for already approved sessions
    expect(gitCommands).not.toContain("git branch -d pr/task#265");
    expect(gitCommands).not.toContain("git branch -d task#265");
  });
});
