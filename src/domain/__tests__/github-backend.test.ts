/**
 * GitHub Repository Backend Tests
 * 
 * Note: This test directly replaces the logger module to avoid loading winston.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { createMock, mockModule, setupTestMocks } from "../../utils/test-utils/mocking.js";
import { GitHubBackend } from "../repository/github.js";
import type { RepositoryStatus } from "../repository.js";
import type { RepositoryBackendConfig } from "../repository/index.js";

// Set up automatic mock cleanup
setupTestMocks();

// Create mock logger
const mockLog = {
  info: createMock(),
  error: createMock(),
  debug: createMock(),
  warn: createMock()
};

// Mock the logger module
mockModule("../../utils/logger.js", () => ({ log: mockLog }));

// Mock environment variables
const originalEnv = { ...process.env };
process.env.HOME = "/mock-home";
process.env.XDG_STATE_HOME = "/mock-xdg-state";

// Mock child_process.exec
const mockExec = createMock();
mockModule("child_process", () => ({
  exec: mockExec
}));

// Mock fs.promises
const mockMkdir = createMock();
mockModule("fs/promises", () => ({
  mkdir: mockMkdir
}));

// Mock session database
const mockSessionDb = {
  listSessions: createMock(),
  getSession: createMock()
};
mockModule("../session.js", () => ({
  SessionDB: createMock(() => mockSessionDb)
}));

// Mock GitService
const mockGitService = {
  clone: createMock(),
  push: createMock(),
  pullLatest: createMock(),
  getStatus: createMock(),
  getSessionWorkdir: createMock((repoName, session) => 
    `/mock-xdg-state/minsky/git/${repoName}/sessions/${session}`)
};
mockModule("../git.js", () => ({
  GitService: createMock(() => mockGitService)
}));

// Mock repo-utils
mockModule("../repo-utils.js", () => ({
  normalizeRepoName: (url: string) => {
    if (url.includes("github.com")) {
      return url.split("/").slice(-2).join("/").replace(".git", "");
    }
    return "user/repo";
  }
}));

describe("GitHub Repository Backend", () => {
  // Reset mocks before each test
  beforeEach(() => {
    mockMkdir.mockReset();
    mockExec.mockReset();
    mockSessionDb.listSessions.mockReset();
    mockSessionDb.getSession.mockReset();
    mockGitService.clone.mockReset();
    mockGitService.push.mockReset();
    mockGitService.pullLatest.mockReset();
    mockGitService.getStatus.mockReset();
  });

  // Restore environment variables after all tests
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("constructor", () => {
    test("initializes with repository URL", () => {
      // Arrange & Act
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Assert
      expect(backend.getType()).toBe("github");
    });

    test("initializes with owner and repo details", () => {
      // Arrange & Act
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      // Assert
      expect(backend.getType()).toBe("github");
    });

    test("throws error when repository URL is missing", () => {
      // Arrange, Act & Assert
      let error: Error | undefined;
      try {
        new GitHubBackend({
          type: "github",
          repoUrl: "" // Empty URL
        });
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("Repository URL is required");
    });
  });

  describe("clone", () => {
    test("properly calls GitService.clone with correct parameters", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      mockMkdir.mockResolvedValue(undefined);
      mockGitService.clone.mockResolvedValue({
        workdir: "/mock-xdg-state/minsky/git/user/repo/sessions/test-session",
        session: "test-session"
      });

      // Act
      const result = await backend.clone("test-session");

      // Assert
      expect(mockMkdir.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.clone).toHaveBeenCalledWith({
        repoUrl: "https://github.com/user/repo.git",
        session: "test-session"
      });
      expect(result.workdir).toContain("test-session");
      expect(result.session).toBe("test-session");
    });
  });

  describe("getPath", () => {
    test("returns path with specified session", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Act
      const path = await backend.getPath("test-session");

      // Assert
      expect(path).toContain("/mock-xdg-state/minsky/git/");
      expect(path).toContain("test-session");
    });
  });

  describe("getConfig", () => {
    test("returns the repository configuration", () => {
      // Arrange
      const config: RepositoryBackendConfig = {
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      };
      
      const backend = new GitHubBackend(config);

      // Act
      const result = backend.getConfig();

      // Assert
      expect(result.type).toBe("github");
      expect(result.repoUrl).toBe("https://github.com/user/repo.git");
      expect(result.github?.owner).toBe("user");
      expect(result.github?.repo).toBe("repo");
    });
  });
}); 
