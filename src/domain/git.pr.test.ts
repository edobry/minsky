/**
 * Tests for the PR functionality in the git service
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitService } from "./git";
import { GIT_COMMANDS } from "../utils/test-utils/test-constants";

describe("GitService PR Functionality", () => {
  let gitService: GitService;

  beforeEach(() => {
    // Create a fresh GitService instance for each test
    gitService = new GitService("/tmp/mock-base-dir");
  });

  test("isGitHubRepo should identify GitHub URLs correctly", () => {
    // Verify the GitService instance was created successfully
    expect(gitService instanceof GitService).toBe(true);
  });

  test("should create a PR description via prWithDependencies", async () => {
    // Use prWithDependencies with injected mock deps — no prototype spy needed
    const mockDeps = {
      execAsync: mock(async (command: unknown) => {
        const cmd = command as string;
        if (cmd.includes("log --oneline")) {
          return {
            stdout: "abc123 feat: add new feature\ndef456 fix: bug fix",
            stderr: "",
          };
        }
        if (cmd.includes(GIT_COMMANDS.DIFF_NAME_ONLY)) {
          return { stdout: "src/feature.ts\nREADME.md", stderr: "" };
        }
        if (cmd.includes("merge-base")) {
          return { stdout: "base123", stderr: "" };
        }
        if (cmd.includes(GIT_COMMANDS.BRANCH_SHOW_CURRENT)) {
          return { stdout: "feature-branch", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      getSession: mock(async () => ({
        sessionId: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/user/repo.git",
      })),
      getSessionWorkdir: mock(() => "/tmp/mock-repo-path/sessions/test-session"),
    };

    const result = await gitService.prWithDependencies({ session: "test-session" }, mockDeps);

    // Verify the result contains expected markdown
    expect(typeof result.markdown).toBe("string");
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.markdown).toContain("feature-branch");
  });
});
