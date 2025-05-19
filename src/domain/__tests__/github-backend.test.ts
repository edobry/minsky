/**
 * GitHub Repository Backend Tests
 * 
 * Note: This test directly replaces the logger module to avoid loading winston.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import {
  createMock,
  mockModule,
  setupTestMocks
} from "../../utils/test-utils/mocking.js";
import { GitHubBackend } from "../repository/github.js";
import type { RepositoryStatus } from "../repository.js";
import type { RepositoryBackendConfig } from "../repository/index.js";

// Set up automatic mock cleanup
setupTestMocks();

// Directly mock winston (to avoid dependency errors)
mock.module("winston", () => ({
  format: {
    combine: () => ({}),
    timestamp: () => ({}),
    errors: () => ({}),
    json: () => ({}),
    colorize: () => ({}),
    printf: () => ({})
  },
  transports: {
    Console: class Console {},
    File: class File {}
  },
  createLogger: () => ({
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: () => {}
  })
}));

// Create a dummy log module that will be used in the test
const mockLog = {
  agent: createMock(),
  debug: createMock(),
  warn: createMock(),
  error: createMock(),
  cli: createMock(),
  cliWarn: createMock(),
  cliError: createMock(),
  setLevel: createMock(),
  cliDebug: createMock()
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
  getSessionWorkdir: createMock((repoName: string, session: string) => `/mock-xdg-state/minsky/git/${repoName}/sessions/${session}`)
};
mockModule("../git.js", () => ({
  GitService: createMock(() => mockGitService)
}));

// Mock repo-utils
mockModule("../repo-utils.js", () => ({
  normalizeRepoName: (url: string) => {
    if (url.includes("github.com")) {
      return url.includes("/") ? url.split("/").slice(-2).join("/").replace(".git", "") : "user/repo";
    }
    return "user/repo";
  }
}));

describe("GitHub Repository Backend", () => {
  // Reset mocks before each test
  beforeEach(() => {
    // Clear all mocks
    Object.keys(mockLog).forEach(key => {
      (mockLog as any)[key].mockClear();
    });
    mockExec.mockClear();
    mockMkdir.mockClear();
    mockSessionDb.listSessions.mockClear();
    mockSessionDb.getSession.mockClear();
    mockGitService.clone.mockClear();
    mockGitService.push.mockClear();
    mockGitService.pullLatest.mockClear();
    mockGitService.getStatus.mockClear();
    mockGitService.getSessionWorkdir.mockClear();
  });

  // Restore environment variables after all tests
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("constructor", () => {
    test("should initialize with repository URL", () => {
      // Arrange & Act
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Assert
      expect(backend.getType()).toBe("github");
    });

    test("should initialize with owner and repo details", () => {
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

    test("should throw error when repository URL is missing", () => {
      // Arrange & Act
      let error: Error | undefined;
      
      try {
        new GitHubBackend({
          type: "github",
          repoUrl: "" // Empty URL
        });
      } catch (e) {
        error = e as Error;
      }
      
      // Assert
      expect(error).toBeDefined();
      expect(error?.message).toContain("Repository URL is required");
    });
  });

  describe("clone", () => {
    test("should clone GitHub repository", async () => {
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
      expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
      expect(mockGitService.clone).toHaveBeenCalledWith({
        repoUrl: "https://github.com/user/repo.git",
        session: "test-session"
      });
      expect(result.workdir).toContain("test-session");
      expect(result.session).toBe("test-session");
    });

    test("should handle authentication failures", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      mockMkdir.mockResolvedValue(undefined);
      const authError = new Error("Authentication failed");
      mockGitService.clone.mockRejectedValue(authError);

      // Act & Assert
      let error: Error | undefined;
      try {
        await backend.clone("test-session");
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("GitHub authentication failed");
    });

    test("should handle repository not found errors", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      mockMkdir.mockResolvedValue(undefined);
      const notFoundError = new Error("not found");
      mockGitService.clone.mockRejectedValue(notFoundError);

      // Act & Assert
      let error: Error | undefined;
      try {
        await backend.clone("test-session");
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("GitHub repository not found");
    });
  });

  describe("branch", () => {
    test("should create a new branch", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      mockMkdir.mockResolvedValue(undefined);
      mockExec.mockImplementation((cmd, cb) => {
        cb(null, { stdout: "", stderr: "" });
      });

      // Act
      const result = await backend.branch("test-session", "feature-branch");

      // Assert
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C"), expect.any(Function));
      expect(mockExec.mock.calls[0]?.[0]).toContain("checkout -b feature-branch");
      expect(result.workdir).toContain("test-session");
      expect(result.branch).toBe("feature-branch");
    });

    test("should handle branch creation errors", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      mockMkdir.mockResolvedValue(undefined);
      mockExec.mockImplementation((cmd, cb) => {
        cb(new Error("Branch already exists"), { stdout: "", stderr: "fatal: branch exists" });
      });

      // Act & Assert
      let error: Error | undefined;
      try {
        await backend.branch("test-session", "existing-branch");
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("Failed to create branch in GitHub repository");
    });
  });

  describe("getStatus", () => {
    test("should return repository status", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      // Mock session database
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock Git status
      mockGitService.getStatus.mockResolvedValue({
        modified: ["file1.txt", "file2.txt"],
        untracked: ["new-file.txt"],
        deleted: ["old-file.txt"]
      });

      // Mock exec calls for different git commands
      mockExec.mockImplementation((cmd, cb) => {
        if (cmd.includes("rev-parse")) {
          cb(null, { stdout: "feature-branch\n", stderr: "" });
        } else if (cmd.includes("rev-list")) {
          cb(null, { stdout: "3 2\n", stderr: "" });
        } else if (cmd.includes("remote -v")) {
          cb(null, { stdout: "origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      // Act
      const status = await backend.getStatus() as RepositoryStatus;

      // Assert
      expect(mockSessionDb.listSessions).toHaveBeenCalledWith();
      expect(mockGitService.getStatus).toHaveBeenCalledWith(expect.any(String));
      expect(mockExec).toHaveBeenCalledWith(expect.any(String), expect.any(Function));

      expect(status.branch).toBe("feature-branch");
      expect(status.clean).toBe(false);
      expect(status.dirty).toBe(true);
      expect(status.ahead).toBe(2);
      expect(status.behind).toBe(3);
      expect(status.modifiedFiles?.length).toBe(3); // modified + untracked + deleted
      expect(status.changes.length).toBe(3);
      expect(status.remotes).toContain("origin");
      expect(status.gitHubOwner).toBe("user");
      expect(status.gitHubRepo).toBe("repo");
    });

    test("should handle error when no session found", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock empty sessions
      mockSessionDb.listSessions.mockResolvedValue([]);

      // Act & Assert
      let error: Error | undefined;
      try {
        await backend.getStatus();
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("No session found for this repository");
    });
  });

  describe("getPath", () => {
    test("should return path with specified session", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Act
      const path = await backend.getPath("test-session");

      // Assert
      expect(path).toContain("/minsky/git/user/repo/sessions/test-session");
    });

    test("should find session path when no session specified", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Act
      const path = await backend.getPath();

      // Assert
      expect(mockSessionDb.listSessions).toHaveBeenCalledWith();
      expect(path).toContain("/minsky/git/user/repo/sessions/test-session");
    });

    test("should return base dir when no session found", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock empty sessions
      mockSessionDb.listSessions.mockResolvedValue([]);

      // Act
      const path = await backend.getPath();

      // Assert
      expect(mockSessionDb.listSessions).toHaveBeenCalledWith();
      expect(path).toContain("/minsky/git");
    });
  });

  describe("validate", () => {
    test("should validate repository with owner and repo", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      // Mock curl API check
      mockExec.mockImplementation((cmd, cb) => {
        if (cmd.includes("curl")) {
          cb(null, { stdout: "200", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      // Act
      const result = await backend.validate();

      // Assert
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("curl"), expect.any(Function));
      expect(mockExec.mock.calls[0]?.[0]).toContain("api.github.com/repos/user/repo");
      expect(result.valid).toBe(true);
      expect(result.success).toBe(true);
    });

    test("should handle repository not found", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/nonexistent.git",
        github: {
          owner: "user",
          repo: "nonexistent"
        }
      });

      // Mock curl API check
      mockExec.mockImplementation((cmd, cb) => {
        if (cmd.includes("curl")) {
          cb(null, { stdout: "404", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      // Act
      const result = await backend.validate();

      // Assert
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("curl"), expect.any(Function));
      expect(result.valid).toBe(false);
      expect(result.success).toBe(false);
      expect(result.issues).toContain("GitHub repository not found: user/nonexistent");
    });

    test("should handle API rate limit issues", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      // Mock curl API check
      mockExec.mockImplementation((cmd, cb) => {
        if (cmd.includes("curl")) {
          cb(null, { stdout: "403", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      // Act
      const result = await backend.validate();

      // Assert
      expect(result.valid).toBe(false);
      expect(result.success).toBe(false);
      expect(result.issues).toContain("GitHub API rate limit or permissions issue. The repo may still be valid.");
    });
  });

  describe("push", () => {
    test("should push changes to GitHub", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock successful push
      mockGitService.push.mockResolvedValue({
        pushed: true,
        message: "Successfully pushed to repository"
      });

      // Act
      const result = await backend.push();

      // Assert
      expect(mockSessionDb.listSessions).toHaveBeenCalledWith();
      expect(mockGitService.push).toHaveBeenCalledWith({
        session: "test-session",
        repoPath: expect.stringContaining("test-session"),
        remote: "origin"
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain("Successfully pushed");
    });

    test("should handle no changes to push", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock no changes to push
      mockGitService.push.mockResolvedValue({
        pushed: false,
        message: "No changes to push"
      });

      // Act
      const result = await backend.push();

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain("No changes to push");
    });

    test("should handle push error", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock push error
      mockGitService.push.mockRejectedValue(new Error("Failed to push: authentication required"));

      // Act
      const result = await backend.push();

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to push to repository");
      expect(result.error).toBeDefined();
    });
  });

  describe("pull", () => {
    test("should pull changes from GitHub", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock successful pull
      mockGitService.pullLatest.mockResolvedValue({
        updated: true,
        message: "Successfully pulled changes"
      });

      // Act
      const result = await backend.pull();

      // Assert
      expect(mockSessionDb.listSessions).toHaveBeenCalledWith();
      expect(mockGitService.pullLatest).toHaveBeenCalledWith(
        expect.stringContaining("test-session")
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain("Successfully pulled changes");
    });

    test("should handle already up-to-date", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock no changes to pull
      mockGitService.pullLatest.mockResolvedValue({
        updated: false,
        message: "Already up-to-date"
      });

      // Act
      const result = await backend.pull();

      // Assert
      expect(result.success).toBe(true);
      expect(result.message).toContain("Already up-to-date");
    });

    test("should handle pull error", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock pull error
      mockGitService.pullLatest.mockRejectedValue(new Error("Conflict detected"));

      // Act
      const result = await backend.pull();

      // Assert
      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to pull from repository");
      expect(result.error).toBeDefined();
    });
  });

  describe("checkout", () => {
    test("should checkout existing branch", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock successful checkout
      mockExec.mockImplementation((cmd, cb) => {
        if (cmd.includes("checkout")) {
          cb(null, { stdout: "Switched to branch 'main'", stderr: "" });
        }
      });

      // Act
      await backend.checkout("main");

      // Assert
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C"), expect.any(Function));
      expect(mockExec.mock.calls[0]?.[0]).toContain("checkout main");
    });

    test("should handle checkout errors", async () => {
      // Arrange
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Mock session lookup
      mockSessionDb.listSessions.mockResolvedValue([
        { session: "test-session", repoName: "user/repo", repoUrl: "https://github.com/user/repo.git" }
      ]);

      // Mock checkout error
      mockExec.mockImplementation((cmd, cb) => {
        cb(new Error("Branch does not exist"), { stdout: "", stderr: "error: pathspec 'nonexistent' did not match any file(s) known to git" });
      });

      // Act & Assert
      let error: Error | undefined;
      try {
        await backend.checkout("nonexistent");
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeDefined();
      expect(error?.message).toContain("Failed to checkout branch");
    });
  });

  describe("getConfig", () => {
    test("should return the repository configuration", () => {
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
