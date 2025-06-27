/**
 * NOTE: These tests are temporarily disabled due to issues with git integration testing.
 *
 * The git integration tests require:
 * - Proper git environment setup
 * - Mocking of file system operations
 * - Proper test isolation to prevent test contamination
 *
 * This test suite will be reimplemented with better isolation and test utility support.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../../../domain/git.js";
import { join } from "path";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { execSync } from "child_process";

// Constants
const TEST_TIMEOUT_MS = 30000; // 30 second timeout for git operations

// Test utilities for file handling and git operations
async function initGitRepo(repoPath: string) {
  // Initialize a git repository using direct execSync calls
  execSync("git init", { cwd: repoPath });
  execSync("git config user.name 'Test User'", { cwd: repoPath });
  execSync("git config user.email 'test@example.com'", { cwd: repoPath });

  // Create README and initial commit
  await writeFile(join(repoPath, "README.md"), "# Test Repository");
  execSync("git add README.md", { cwd: repoPath });
  execSync("git commit -m 'Initial commit'", { cwd: repoPath });

  return repoPath;
}

// Execute git command safely and return stdout
function execGit(_command: string, cwd: string): string {
  const result = execSync(`git ${_command}`, { cwd, encoding: "utf8" });
  return result.toString();
}

// Temporarily disabled - these tests pass individually but hang in full suite due to test isolation issues
// describe("Git Integration Tests", () => {

describe.skip("Git Integration Tests", () => {
  let tempDir: string;
  let gitService: GitService;
  let repoPath: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "minsky-git-test-"));
    repoPath = join(tempDir, "test-repo");

    // Create the repo directory
    await mkdir(repoPath, { recursive: true });

    // Initialize a git repository
    await initGitRepo(repoPath);

    // Verify the repo was correctly initialized
    const logs = execGit("log --oneline", repoPath);

    if (!logs.includes("Initial commit")) {
      throw new Error("Failed to initialize git repository correctly");
    }

    // Initialize the git service with the temp directory
    gitService = new GitService(tempDir);
  });

  test("execInRepository executes git commands in the repository", async () => {
    // Act
    const _result = await gitService.execInRepository(repoPath, "git log --oneline -n 1");

    // Assert
    expect(_result).toContain("Initial commit");
  }, TEST_TIMEOUT_MS);

  test("getSessionWorkdir returns the correct workdir path", () => {
    // Arrange
    const repoName = "test-repo";
    const _sessionName = "test-session";

    // Act
    const _workdir = gitService.getSessionWorkdir(repoName, _sessionName);

    // Assert
    expect(_workdir).toContain(repoName);
    expect(_workdir).toContain(_sessionName);
    expect(_workdir).toContain("sessions");
  }, TEST_TIMEOUT_MS);

  test("getStatus returns correct file status", async () => {
    // Arrange - create various file states
    await writeFile(join(repoPath, "modified.txt"), "Modified file");
    execGit("add modified.txt", repoPath);
    execGit("commit -m 'Add file to modify'", repoPath);

    await writeFile(join(repoPath, "modified.txt"), "Modified content");
    await writeFile(join(repoPath, "untracked.txt"), "Untracked file");

    // Act
    const status = await gitService.getStatus(repoPath);

    // Assert
    expect(status.untracked).toContain("untracked.txt");
    expect(status.modified).toContain("modified.txt");
  }, TEST_TIMEOUT_MS);

  test("commit creates a commit with the provided message", async () => {
    // Arrange
    await writeFile(join(repoPath, "to-commit.txt"), "File to commit");
    execGit("add to-commit.txt", repoPath);

    const commitMessage = "Test commit message";

    // Act
    await gitService.commit(commitMessage, repoPath);

    // Assert
    const logResult = execGit("log -1 --pretty=%B", repoPath);
    expect(logResult.trim()).toBe(commitMessage);
  }, TEST_TIMEOUT_MS);

  test("stageAll adds all files to staging", async () => {
    // Arrange
    await writeFile(join(repoPath, "staged1.txt"), "File 1");
    await writeFile(join(repoPath, "staged2.txt"), "File 2");

    // Act
    await gitService.stageAll(repoPath);

    // Assert
    const _status = execGit("status --porcelain", repoPath);
    expect(_status).toContain("A  staged1.txt");
    expect(_status).toContain("A  staged2.txt");
  }, TEST_TIMEOUT_MS);

  test("getCommitsOnBranch gets formatted commits", async () => {
    // Arrange - create multiple commits
    await writeFile(join(repoPath, "file1.txt"), "File 1");
    execGit("add file1.txt", repoPath);
    execGit("commit -m 'Add file1'", repoPath);

    await writeFile(join(repoPath, "file2.txt"), "File 2");
    execGit("add file2.txt", repoPath);
    execGit("commit -m 'Add file2'", repoPath);

    // Act - We need to call execInRepository directly since getCommitsOnBranch is private
    const _result = await gitService.execInRepository(
      repoPath,
      "git log --pretty=format:'%h %s' -n 2"
    );

    // Assert
    expect(_result).toContain("Add file2");
    expect(_result).toContain("Add file1");
  }, TEST_TIMEOUT_MS);

  // Skip tests that require stashing for now, as they're more complex
});
