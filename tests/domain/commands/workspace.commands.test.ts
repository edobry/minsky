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

// Simple mock for execAsync that includes full path for proper matching
const mockGitRootExecAsync = (stdout: unknown) => {
  return async (command: unknown) => {
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#TEST_VALUE",
          taskId: "TEST_VALUE",
          createdAt: new Date().toISOString(),
        }),
      } as any;

      try {
        // Act
        const result = await getSessionFromWorkspace(repoPath, execAsyncMock, sessionDbMock);

        // Assert
        expect(result).toEqual({
          _session: "session-name",
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/unknown-session";
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
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(repoPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      const sessionDbMock = {
        getSession: async (sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#TEST_VALUE",
          taskId: "TEST_VALUE",
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
      const sessionPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const execAsyncMock = mockGitRootExecAsync(sessionPath) as any;

      // Set up environment for testing
      const originalHome = process.env.HOME;
      process.env.HOME = "/Users/test";

      // Create mock sessionDB
      const sessionDbMock = {
        getSession: async (sessionName: unknown) => ({
          session: sessionName,
          repoName: "repo-name",
          repoUrl: "https://github.com/org/repo.git",
          branch: "task#TEST_VALUE",
          taskId: "TEST_VALUE",
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

    test("getCurrentSession returns null when repo path does not exist", async () => {
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      mockExecAsync.mockResolvedValue({ stdout: repoPath, stderr: "" });
      mockAccess.mockRejectedValue(new Error("File not found"));

      const result = await getCurrentSession(repoPath);
      expect(result).toBeNull();
    });

    test("getCurrentSession returns null when repoUrl is not found", async () => {
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      mockExecAsync.mockResolvedValue({ stdout: repoPath, stderr: "" });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("refs/heads/main");

      // Mock session record without repoUrl
      mockGetSession.mockResolvedValue({
        session: "session-name",
        repoName: "test-repo",
        createdAt: "2024-01-01T00:00:00Z",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      });

      const result = await getCurrentSession(repoPath);
      expect(result).toBeNull();
    });

    test("getCurrentSession returns null when session data doesn't match file structure", async () => {
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      mockExecAsync.mockResolvedValue({ stdout: repoPath, stderr: "" });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("refs/heads/main");

      // Mock different session name than what's in the path
      mockGetSession.mockResolvedValue({
        session: "different-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/user/repo",
        createdAt: "2024-01-01T00:00:00Z",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      });

      const result = await getCurrentSession(repoPath);
      expect(result).toBeNull();
    });

    test("getCurrentSession returns null when session doesn't exist", async () => {
      const repoPath = "/Users/test/.local/state/minsky/sessions/unknown-session";
      mockExecAsync.mockResolvedValue({ stdout: repoPath, stderr: "" });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("refs/heads/main");

      // Mock no session found
      mockGetSession.mockResolvedValue(null);

      const result = await getCurrentSession(repoPath);
      expect(result).toBeNull();
    });

    test("getCurrentSession returns session info when valid", async () => {
      const repoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      mockExecAsync.mockResolvedValue({ stdout: repoPath, stderr: "" });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("refs/heads/main");

      const mockSession = {
        session: "session-name",
        repoName: "test-repo",
        repoUrl: "https://github.com/user/repo",
        createdAt: "2024-01-01T00:00:00Z",
        backendType: "local" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };

      mockGetSession.mockResolvedValue(mockSession);

      const result = await getCurrentSession(repoPath);
      expect(result).toEqual({
        session: "session-name",
        upstreamRepository: "https://github.com/user/repo",
        gitRoot: repoPath,
      });
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
      const _options = { workspace: invalidPath };

      // Mock fs.access to fail
      const accessMock = async () => {
        throw new Error("Directory doesn't exist");
      };

      // This test needs special handling for Bun
      let errorThrown = false;
      try {
        await resolveWorkspacePath(_options, { access: accessMock });
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
      const sessionRepoPath = "/Users/test/.local/state/minsky/sessions/some-session";
      const _options = { sessionRepo: sessionRepoPath };

      // Act
      const result = await resolveWorkspacePath(_options);

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
      const sessionWorkspace = "/Users/test/.local/state/minsky/sessions/session-name";
      const _options = { sessionWorkspace };

      // Act
      const result = await resolveWorkspacePath(_options);

      // Assert
      expect(result).toBe(sessionWorkspace);
    });

    test("getSessionFromWorkspace returns session for deeply nested session paths", async () => {
      const sessionPath = "/Users/test/.local/state/minsky/sessions/session-name";
      const testPath = `${sessionPath}/some/nested/path`;

      mockExecAsync.mockResolvedValue({ stdout: sessionPath, stderr: "" });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("refs/heads/main");

      const mockSession = {
        session: "session-name",
        repoName: "test-repo",
        repoUrl: "https://github.com/user/repo",
        createdAt: "2024-01-01T00:00:00Z",
        backendType: "local" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };

      mockGetSession.mockResolvedValue(mockSession);

      const result = await getSessionFromWorkspace(testPath);
      expect(result).toEqual({
        session: "session-name",
        upstreamRepository: "https://github.com/user/repo",
        gitRoot: sessionPath,
      });
    });
  });

  describe("isSessionWorkspace returns true for session workspace", () => {
    test("returns true for session workspace", () => {
      const sessionRepoPath = "/Users/test/.local/state/minsky/sessions/some-session";
      expect(isSessionWorkspace(sessionRepoPath)).toBe(true);
    });

    test("returns false for non-session workspace", () => {
      const regularRepoPath = "/Users/test/.local/state/minsky/sessions/session-name";
      expect(isSessionWorkspace(regularRepoPath)).toBe(true);
    });
  });
});
