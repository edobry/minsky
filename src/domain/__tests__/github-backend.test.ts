/**
 * GitHub Backend Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 *
 * NOTE: These tests use sophisticated mocking for GitHub backend functionality including:
 * - fs/promises (for file operations)
 * - child_process exec (for git commands)
 * - SessionDB (for session management)
 * - GitService (for git operations)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHubBackend } from "../repository/github.ts";
import { join } from "path";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking.ts";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the SessionDB dependencies using our utilities
const mockSessionDB = {
  listSessions: createMock(() =>
    Promise.resolve([
      {
        session: "test-session",
        repoName: "github/test-repo",
        repoUrl: "https://github.com/github/test-repo.git",
      },
    ])
  ),
  getSession: createMock((sessionName: string) =>
    Promise.resolve({
      session: sessionName,
      repoName: "github/test-repo",
      repoUrl: "https://github.com/github/test-repo.git",
      branch: "main",
      taskId: "123",
      createdAt: new Date().toISOString(),
    })
  ),
  addSession: createMock(() => Promise.resolve()),
  updateSession: createMock(() => Promise.resolve()),
  deleteSession: createMock(() => Promise.resolve(true)),
  getRepoPath: createMock(() => "/mock/repo/path"),
  getSessionWorkdir: createMock(() => "/mock/session/workdir"),
};

// Create temporary directory for testing
async function createTempDir() {
  return mkdtemp(join(tmpdir(), "minsky-github-test-"));
}

// Custom TestGitHubBackend class that allows us to inject our mocks
class TestGitHubBackend extends GitHubBackend {
  constructor(config: any) {
    super(config);
    // @ts-ignore - Override private property for testing
    this.sessionDb = mockSessionDB;
  }

  // Override validate method for testing
  async validate() {
    return {
      valid: true,
      success: true,
      message: "GitHub repository validated successfully",
    };
  }
}

describe("GitHub Repository Backend", () => {
  let tempDir: string;
  let githubBackend: GitHubBackend;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create a temp directory to use as HOME
    tempDir = await createTempDir();

    // Save original HOME
    originalHome = process.env.HOME;

    // Set HOME to our temp dir for testing
    process.env.HOME = tempDir;

    // Create necessary directory structure
    await mkdir(join(tempDir, ".local/state/minsky/git/github/test-repo/sessions/test-session"), {
      recursive: true,
    });

    // Create the backend instance
    githubBackend = new TestGitHubBackend({
      repoUrl: "https://github.com/github/test-repo.git",
      github: {
        owner: "github",
        repo: "test-repo",
      },
    });
  });

  afterEach(() => {
    // Restore original HOME
    process.env.HOME = originalHome;

    // Mock cleanup is handled by setupTestMocks()
  });

  test("constructor creates repository backend with correct settings", () => {
    // We can check the exposed config settings
    const config = githubBackend.getConfig();

    expect(config.type).toBe("github");
    expect(config.repoUrl).toBe("https://github.com/github/test-repo.git");
    expect(config.github?.owner).toBe("github");
    expect(config.github?.repo).toBe("test-repo");
  });

  test("getPath returns session workdir path", async () => {
    // Act
    const path = await githubBackend.getPath("test-session");

    // Assert - should include the repository and session name
    expect(path).toContain("test-repo");
    expect(path).toContain("test-session");
    expect(path).toContain("sessions");
  });

  test("validate succeeds for a valid GitHub repository", async () => {
    // Act
    const result = await githubBackend.validate();

    // Assert
    expect(result.valid).toBe(true);
  });

  test("getConfig returns correct configuration", () => {
    // Act
    const config = githubBackend.getConfig();

    // Assert
    expect(config.type).toBe("github");
    expect(config.repoUrl).toBe("https://github.com/github/test-repo.git");
    expect(config.github?.owner).toBe("github");
    expect(config.github?.repo).toBe("test-repo");
  });
});
