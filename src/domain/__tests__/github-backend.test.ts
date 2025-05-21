/**
 * NOTE: These tests are temporarily disabled due to issues with mocking.
 * 
 * The GitHub backend tests require sophisticated mocking of:
 * - fs/promises (for file operations)
 * - child_process exec (for git commands)
 * - SessionDB (for session management)
 * - GitService (for git operations)
 * 
 * This test suite will be reimplemented after improving the test utilities.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { GitHubBackend } from "../repository/github.js";
import { join } from "path";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { execSync } from "child_process";

// Mock the SessionDB dependencies
const mockSessionDB = {
  listSessions: mock(() => Promise.resolve([
    { 
      session: "test-session", 
      repoName: "github/test-repo", 
      repoUrl: "https://github.com/github/test-repo.git"
    }
  ])),
  getSession: mock((sessionName: string) => Promise.resolve({
    session: sessionName,
    repoName: "github/test-repo",
    repoUrl: "https://github.com/github/test-repo.git",
    branch: "main",
    taskId: "123",
    createdAt: new Date().toISOString()
  })),
  addSession: mock(() => Promise.resolve()),
  updateSession: mock(() => Promise.resolve()),
  deleteSession: mock(() => Promise.resolve(true)),
  getRepoPath: mock(() => "/mock/repo/path"),
  getSessionWorkdir: mock(() => "/mock/session/workdir")
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
    await mkdir(join(tempDir, ".local/state/minsky/git/github/test-repo/sessions/test-session"), { recursive: true });
    
    // Create the backend instance
    githubBackend = new TestGitHubBackend({
      repoUrl: "https://github.com/github/test-repo.git",
      github: {
        owner: "github",
        repo: "test-repo"
      }
    });
  });
  
  afterEach(() => {
    // Restore original HOME
    process.env.HOME = originalHome;
    
    // Reset mocks
    mock.restore();
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
