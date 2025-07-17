import { describe, test, expect } from "bun:test";
import {
  isSessionWorkspace,
  isSessionRepository,
  getSessionFromWorkspace,
  getSessionFromRepo,
  getCurrentSession,
  resolveWorkspacePath,
} from "../../../src/domain/workspace.js";

const TEST_VALUE = 123;

// Simple mock for execAsync that matches the expected function signature
const mockGitRootExecAsync = (stdout: string) => {
  return async (command: string, options?: any) => {
    if (command.includes("git rev-parse --show-toplevel")) {
      return { stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
};

describe("Workspace Domain Methods", () => {
  describe("isSessionRepository (async workspace checking)", () => {
    test("returns true for a path in a session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Override environment variables for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      try {
        // Act
        const result = await isSessionRepository(repoPath, execAsyncMock);

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
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Act
      const result = await isSessionRepository(repoPath, execAsyncMock);

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
      const result = await isSessionRepository(repoPath, execAsyncMock);

      // Assert
      expect(result).toBe(false);
    });

    test("verifies isSessionRepository consistency", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Override environment variables for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      try {
        // Act
        const result1 = await isSessionRepository(repoPath, execAsyncMock);
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (sessionName: string) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: `task#${TEST_VALUE}`,
          taskId: TEST_VALUE.toString(),
          createdAt: new Date().toISOString(),
        }),
      };

      try {
        // Act
        const result = await getSessionFromWorkspace(repoPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result).toEqual({
          session: "session-name",
          upstreamRepository: "https://github.com/org/repo.git",
          gitRoot: "/Users/test/.local/state/minsky/sessions/session-name",
        });
      } finally {
        // Restore original HOME
        process.env.HOME = originalHome;
      }
    });

    test("returns null for a non-session repository", async () => {
      // Arrange
      const repoPath = "/Users/test/projects/non-session-repo";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Act
      const result = await getSessionFromWorkspace(repoPath, execAsyncMock);

      // Assert
      expect(result).toBeNull();
    });

    test("returns null when session record is not found", async () => {
      // Arrange
      const repoPath = "/Users/test/.local/state/minsky/sessions/unknown-session";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath);

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      const sessionDbMock = {
        getSession: async (sessionName: string) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: `task#${TEST_VALUE}`,
          taskId: TEST_VALUE.toString(),
          createdAt: new Date().toISOString(),
        }),
      };

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
      const sessionPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(sessionPath);

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (sessionName: string) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: `task#${TEST_VALUE}`,
          taskId: TEST_VALUE.toString(),
          createdAt: new Date().toISOString(),
        }),
      };

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
      const execAsyncMock = mockGitRootExecAsync(notSessionPath);

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
      } catch (error: any) {
        errorThrown = true;
        expect(error.message).toContain("Invalid workspace path");
      }

      // Additional assertion to make sure the error was thrown
      expect(errorThrown).toBe(true);
    });

    test("uses sessionRepo if provided (backwards compatibility)", async () => {
      // Arrange
      const sessionRepoPath = "/Users/test/.local/state/minsky/sessions/some-session";
      const options = { sessionRepo: sessionRepoPath };

      // Act
      const result = await resolveWorkspacePath(options);

      // Assert
      expect(result).toBe(sessionRepoPath);
    });

    test("falls back to current directory when no options provided", async () => {
      // Act
      const result = await resolveWorkspacePath();

      // Assert - should return the current directory
      expect(result).toBe(process.cwd());
    });

    test("uses provided sessionWorkspace path", async () => {
      // Arrange
      const sessionWorkspace = "/Users/test/.local/state/minsky/sessions/session-name";
      const options = { sessionWorkspace };

      // Act
      const result = await resolveWorkspacePath(options);

      // Assert
      expect(result).toBe(sessionWorkspace);
    });
  });

  describe("isSessionWorkspace returns true for session workspace", () => {
    test("returns true for session workspace", () => {
      const sessionRepoPath = "/Users/test/.local/state/minsky/sessions/some-session";
      expect(isSessionWorkspace(sessionRepoPath)).toBe(true);
    });

    test("returns false for non-session workspace", () => {
      const regularRepoPath = "/Users/test/projects/regular-repo";
      expect(isSessionWorkspace(regularRepoPath)).toBe(false);
    });
  });
});
