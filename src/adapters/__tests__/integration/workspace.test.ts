import { describe, test, expect, beforeEach } from "bun:test";
import {
  isSessionRepository,
  getSessionFromRepo,
  getCurrentSession,
  resolveWorkspacePath,
  type WorkspaceResolutionOptions
} from "../../../domain/workspace.js";
import {
  createMock,
  mockModule,
  setupTestMocks
} from "../../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the workspace domain methods
const mockIsSessionRepository = createMock();
const mockGetSessionFromRepo = createMock();
const mockGetCurrentSession = createMock();
const mockResolveWorkspacePath = createMock();

// Mock the fs access function
const mockFsAccess = createMock();

// Mock the exec function
const mockExecAsync = createMock();

// Mock the domain workspace module
mockModule("../../../domain/workspace.js", () => {
  return {
    isSessionRepository: mockIsSessionRepository,
    getSessionFromRepo: mockGetSessionFromRepo,
    getCurrentSession: mockGetCurrentSession,
    resolveWorkspacePath: mockResolveWorkspacePath
  };
});

describe("Workspace Domain Methods", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockIsSessionRepository.mockReset();
    mockGetSessionFromRepo.mockReset();
    mockGetCurrentSession.mockReset();
    mockResolveWorkspacePath.mockReset();
    mockFsAccess.mockReset();
    mockExecAsync.mockReset();
  });

  describe("isSessionRepository", () => {
    test("returns true for a path in a session repository", async () => {
      // Arrange
      const repoPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
      mockIsSessionRepository.mockResolvedValue(true);
      
      // Act
      const result = await isSessionRepository(repoPath);
      
      // Assert
      expect(mockIsSessionRepository).toHaveBeenCalledWith(repoPath);
      expect(result).toBe(true);
    });

    test("returns false for a path not in a session repository", async () => {
      // Arrange
      const repoPath = "/Users/user/projects/non-session-repo";
      mockIsSessionRepository.mockResolvedValue(false);
      
      // Act
      const result = await isSessionRepository(repoPath);
      
      // Assert
      expect(mockIsSessionRepository).toHaveBeenCalledWith(repoPath);
      expect(result).toBe(false);
    });

    test("returns false when an error occurs during check", async () => {
      // Arrange
      const repoPath = "/invalid/path";
      mockIsSessionRepository.mockRejectedValue(new Error("Git command failed"));
      
      try {
        // Act
        await isSessionRepository(repoPath);
      } catch (err) {
        // Assert
        const error = err as Error;
        expect(mockIsSessionRepository).toHaveBeenCalledWith(repoPath);
        expect(error.message).toContain("Git command failed");
      }
    });
  });

  describe("getSessionFromRepo", () => {
    test("gets session information for a valid session repository", async () => {
      // Arrange
      const repoPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
      const expectedResult = {
        session: "session-name",
        mainWorkspace: "https://github.com/org/repo.git"
      };
      mockGetSessionFromRepo.mockResolvedValue(expectedResult);
      
      // Act
      const result = await getSessionFromRepo(repoPath);
      
      // Assert
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith(repoPath);
      expect(result).toEqual(expectedResult);
      expect(result?.session).toBe("session-name");
    });

    test("returns null for a non-session repository", async () => {
      // Arrange
      const repoPath = "/Users/user/projects/non-session-repo";
      mockGetSessionFromRepo.mockResolvedValue(null);
      
      // Act
      const result = await getSessionFromRepo(repoPath);
      
      // Assert
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith(repoPath);
      expect(result).toBeNull();
    });

    test("returns null when session record not found", async () => {
      // Arrange
      const repoPath = "/Users/user/.local/state/minsky/git/repo-name/sessions/unknown-session";
      mockGetSessionFromRepo.mockResolvedValue(null);
      
      // Act
      const result = await getSessionFromRepo(repoPath);
      
      // Assert
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith(repoPath);
      expect(result).toBeNull();
    });
  });

  describe("getCurrentSession", () => {
    test("gets current session name when in a session repository", async () => {
      // Arrange
      const cwd = "/Users/user/.local/state/minsky/git/repo-name/sessions/session-name";
      mockGetCurrentSession.mockResolvedValue("session-name");
      
      // Act
      const result = await getCurrentSession(cwd);
      
      // Assert
      expect(mockGetCurrentSession).toHaveBeenCalledWith(cwd);
      expect(result).toBe("session-name");
    });

    test("returns null when not in a session repository", async () => {
      // Arrange
      const cwd = "/Users/user/projects/non-session-repo";
      mockGetCurrentSession.mockResolvedValue(null);
      
      // Act
      const result = await getCurrentSession(cwd);
      
      // Assert
      expect(mockGetCurrentSession).toHaveBeenCalledWith(cwd);
      expect(result).toBeNull();
    });

    test("uses process.cwd() when no path provided", async () => {
      // Arrange
      mockGetCurrentSession.mockResolvedValue("session-name");
      
      // Act
      const result = await getCurrentSession();
      
      // Assert
      expect(mockGetCurrentSession).toHaveBeenCalledWith();
      expect(result).toBe("session-name");
    });
  });

  describe("resolveWorkspacePath", () => {
    test("returns explicitly provided workspace path", async () => {
      // Arrange
      const options: WorkspaceResolutionOptions = {
        workspace: "/path/to/workspace"
      };
      mockResolveWorkspacePath.mockResolvedValue(options.workspace);
      
      // Act
      const result = await resolveWorkspacePath(options);
      
      // Assert
      expect(mockResolveWorkspacePath).toHaveBeenCalledWith(options);
      expect(result).toBe("/path/to/workspace");
    });

    test("returns current directory when no options provided", async () => {
      // Arrange
      const currentPath = process.cwd();
      mockResolveWorkspacePath.mockResolvedValue(currentPath);
      
      // Act
      const result = await resolveWorkspacePath();
      
      // Assert
      expect(mockResolveWorkspacePath).toHaveBeenCalledWith();
      expect(result).toBe(currentPath);
    });

    test("uses provided session repo path", async () => {
      // Arrange
      const options: WorkspaceResolutionOptions = {
        sessionRepo: "/path/to/session/repo"
      };
      mockResolveWorkspacePath.mockResolvedValue(options.sessionRepo);
      
      // Act
      const result = await resolveWorkspacePath(options);
      
      // Assert
      expect(mockResolveWorkspacePath).toHaveBeenCalledWith(options);
      expect(result).toBe("/path/to/session/repo");
    });

    test("throws error for invalid workspace path", async () => {
      // Arrange
      const options: WorkspaceResolutionOptions = {
        workspace: "/invalid/workspace"
      };
      const error = new Error("Invalid workspace path: /invalid/workspace. Path must be a valid Minsky workspace.");
      mockResolveWorkspacePath.mockRejectedValue(error);
      
      // Act & Assert
      await expect(resolveWorkspacePath(options)).rejects.toThrow("Invalid workspace path");
    });
  });
}); 
