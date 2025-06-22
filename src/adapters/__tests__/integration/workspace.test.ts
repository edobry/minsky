import { describe, test, expect } from "bun:test";
import {
  isSessionWorkspace,
  isSessionRepository,
  getSessionFromWorkspace,
  getSessionFromRepo,
  getCurrentSession,
  resolveWorkspacePath,
} from "../../../domain/workspace.js";

// Simple mock for execAsync that includes full path for proper matching
const mockGitRootExecAsync = (_stdout: unknown) => {
  return async (_command: unknown) => {
    if (command.includes("git rev-parse --show-toplevel")) {
      return { stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
};

describe("Workspace Domain Methods", () => {
  describe("isSessionWorkspace (isSessionRepository)", () => {
    test("returns true for a path in a session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Override environment variables for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      try {
        // Act
        const result = await isSessionWorkspace(repoPath, execAsyncMock);

        // Assert
        expect(result).toBe(true);
      } finally {
        // Restore the original HOME
        process.env.HOME = originalHome;
      }
    });

    test("returns false for a path not in a session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/projects/non-session-repo";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Act
      const result = await isSessionWorkspace(repoPath, execAsyncMock);

      // Assert
      expect(result).toBe(false);
    });

    test("returns false when an error occurs during check", async () => {
      // Arrange
      const repoPath = "/invalid/path";
      const execAsyncMock = async () => {
        throw new Error("Git command failed");
      };

      // Act
      const result = await isSessionWorkspace(repoPath, execAsyncMock as any);

      // Assert
      expect(result).toBe(false);
    });

    test("verifies isSessionRepository is an alias for isSessionWorkspace", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Override environment variables for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      try {
        // Act
        const result1 = await isSessionWorkspace(repoPath, execAsyncMock);
        const result2 = await isSessionRepository(repoPath, execAsyncMock);

        // Assert
        expect(result1).toBe(result2);
      } finally {
        // Restore the original HOME
        process.env.HOME = originalHome;
      }
    });
  });

  describe("getSessionFromWorkspace (getSessionFromRepo)", () => {
    test("gets session information for a valid session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (_sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#123",
          taskId: "123",
          createdAt: new Date().toISOString(),
        }),
      } as any;

      try {
        // Act
        const result = await getSessionFromWorkspace(repoPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result).toEqual({
          session: "session-name",
          upstreamRepository: "https://github.com/org/repo.git",
        });
      } finally {
        // Restore original HOME
        process.env.HOME = originalHome;
      }
    });

    test("returns null for a non-session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/projects/non-session-repo";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Act
      const result = await getSessionFromWorkspace(repoPath, execAsyncMock);

      // Assert
      expect(result).toBeNull();
    });

    test("returns null when session record is not found", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/unknown-session";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB that returns null
      const sessionDbMock = {
        getSession: async () => null,
      };

      try {
        // Act
        const result = await getSessionFromWorkspace(repoPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result).toBeNull();
      } finally {
        // Restore original HOME
        process.env.HOME = originalHome;
      }
    });

    test("verifies getSessionFromRepo is an alias for getSessionFromWorkspace", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      const sessionDbMock = {
        getSession: async (_sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#123",
          taskId: "123",
          createdAt: new Date().toISOString(),
        }),
      } as any;

      try {
        // Act
        const result1 = await getSessionFromWorkspace(repoPath, execAsyncMock, sessionDbMock);
        const result2 = await getSessionFromRepo(repoPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result1).toEqual(result2);
      } finally {
        // Restore original HOME
        process.env.HOME = originalHome;
      }
    });
  });

  describe("getCurrentSession", () => {
    test("returns session name when in a session directory", async () => {
      // Arrange
      const sessionPath = "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(sessionPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (_sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#123",
          taskId: "123",
          createdAt: new Date().toISOString(),
        }),
      } as any;

      try {
        // Act
        const result = await getCurrentSession(sessionPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result).toBe("session-name");
      } finally {
        // Restore original HOME
        process.env.HOME = originalHome;
      }
    });

    test("returns null when not in a session directory", async () => {
      // Arrange
      const notSessionPath = "/Users/test/projects/non-session";
      const execAsyncMock = mockGitRootExecAsync(notSessionPath) as any;

      // Act
      const result = await getCurrentSession(notSessionPath, execAsyncMock);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe("resolveWorkspacePath", () => {
    test("returns explicitly provided workspace path", async () => {
      // Arrange
      const workspacePath = "/Users/test/workspace";
      const options = { workspace: workspacePath };

      // Mock fs.access to succeed
      const accessMock = async () => {};

      // Act
      const result = await resolveWorkspacePath(options, { access: accessMock });

      // Assert
      expect(result).toBe(workspacePath);
    });

    test("throws error for invalid workspace path", async () => {
      // Arrange
      const invalidPath = "/invalid/workspace";
      const options = { workspace: invalidPath };

      // Mock fs.access to fail
      const accessMock = async () => {
        throw new Error("Directory doesn't exist");
      };

      // This test needs special handling for Bun
      let errorThrown = false;
      try {
        await resolveWorkspacePath(options, { access: accessMock });
      } catch (error: unknown) {
        // Type error as any to access error.message
        errorThrown = true;
        expect((error as any).message).toContain("Invalid workspace path");
      }

      // Additional assertion to make sure the error was thrown
      expect(errorThrown).toBe(true);
    });

    test("uses sessionRepo if provided (backwards compatibility)", async () => {
      // Arrange
      const sessionRepoPath = "/Users/test/.local/state/minsky/git/repo-name/some-session";
      const options = { sessionRepo: sessionRepoPath };

      // Act
      const result = await resolveWorkspacePath(options);

      // Assert
      expect(result).toBe(sessionRepoPath);
    });

    test("falls back to current directory when no options provided", async () => {
      // Arrange - no options means using current directory

      // Act
      const result = await resolveWorkspacePath();

      // Assert - should return the current directory
      expect(result).toBe(process.cwd());
    });

    test("uses provided sessionWorkspace path", async () => {
      // Arrange
      const sessionWorkspace =
        "/Users/test/.local/state/minsky/git/repo-name/sessions/session-name";
      const options = { sessionWorkspace };

      // Act
      const result = await resolveWorkspacePath(options);

      // Assert
      expect(result).toBe(sessionWorkspace);
    });
  });
});
