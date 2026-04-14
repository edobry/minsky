import { describe, it, expect, mock } from "bun:test";
import { preparePrImpl } from "./prepare-pr-operations";
import { GIT_COMMANDS } from "../../utils/test-utils/test-constants";

// Mock execGitWithTimeout since that's what preparePrImpl actually uses
const _mockExecGitWithTimeout = mock();

const TEST_SESSION = "550e8400-e29b-41d4-a716-446655440000";
const TEST_BRANCH = "task/md-357";
const TEST_PR_BRANCH = `pr/${TEST_BRANCH}`;

describe("PR Branch Validation Bug Fix", () => {
  // Bug: PR creation from PR branches creates double pr/ prefix (pr/pr/task-name)
  // Root cause: System allows PR creation from any branch, including existing PR branches
  // Expected: PR creation should ONLY be allowed from session branches

  describe("preparePrImpl", () => {
    it("should reject PR creation when current branch is a PR branch", async () => {
      // Mock dependencies with proper session record to avoid session-not-found errors
      const mockSessionDb = {
        getSession: () =>
          Promise.resolve({
            session: TEST_SESSION,
            taskId: "md#357",
            repoName: "test-repo",
            branch: TEST_BRANCH,
            workspacePath: "/mock/workspace",
            sessionWorkspacePath: "/mock/session/workdir",
          }),
        updateSession: () => Promise.resolve(),
        listSessions: () => Promise.resolve([]),
      };

      const mockGetSessionWorkdir = () => "/mock/session/workdir";

      const mockExecInRepository = (workdir: string, command: string) => {
        // Simulate being on a PR branch (this is the bug scenario)
        if (command.includes(GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD)) {
          return Promise.resolve(TEST_PR_BRANCH); // Current branch is already a PR branch
        }
        if (command.includes("git status")) {
          return Promise.resolve("");
        }
        return Promise.resolve("mock-output");
      };

      const mockPush = () => Promise.resolve();

      const options = {
        session: TEST_SESSION,
        title: "Test PR",
        body: "Test body",
        baseBranch: "main",
      };

      const deps = {
        sessionDb: mockSessionDb,
        getSessionWorkdir: mockGetSessionWorkdir,
        execInRepository: mockExecInRepository,
        push: mockPush,
      };

      // This test should FAIL until we fix the bug
      // Currently it creates pr/pr/task/md-357 instead of rejecting
      await expect(preparePrImpl(options, deps as any)).rejects.toThrow(
        /Cannot create PR from PR branch 'pr\/task\/md-357'/
      );
    });

    it("should allow PR creation when current branch is a session branch", async () => {
      // Mock dependencies with proper session record
      const mockSessionDb = {
        getSession: () =>
          Promise.resolve({
            session: TEST_SESSION,
            taskId: "md#357",
            repoName: "test-repo",
            branch: TEST_BRANCH,
            workspacePath: "/mock/workspace",
            sessionWorkspacePath: "/mock/session/workdir",
          }),
        updateSession: () => Promise.resolve(),
        listSessions: () => Promise.resolve([]),
      };

      const mockGetSessionWorkdir = () => "/mock/session/workdir";

      const mockExecInRepository = (workdir: string, command: string) => {
        // Simulate being on a session branch (correct scenario)
        if (command.includes(GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD)) {
          return Promise.resolve(TEST_BRANCH); // Current branch is a session branch
        }
        if (command.includes("git status")) {
          return Promise.resolve("");
        }
        if (command.includes("rev-parse --verify main")) {
          return Promise.resolve("abc123");
        }
        if (command.includes("fetch origin main")) {
          return Promise.resolve("");
        }
        if (command.includes(`checkout -b ${TEST_PR_BRANCH}`)) {
          return Promise.resolve("");
        }
        if (command.includes("merge")) {
          return Promise.resolve("");
        }
        return Promise.resolve("mock-output");
      };

      const mockPush = () => Promise.resolve();

      const options = {
        session: TEST_SESSION,
        title: "Test PR",
        body: "Test body",
        baseBranch: "main",
      };

      const deps = {
        sessionDb: mockSessionDb,
        getSessionWorkdir: mockGetSessionWorkdir,
        execInRepository: mockExecInRepository,
        push: mockPush,
      };

      // This should work fine - creating PR from session branch
      const result = await preparePrImpl(options, deps as any);
      expect(result.prBranch).toBe(TEST_PR_BRANCH);
    });

    it("should detect various PR branch naming patterns", async () => {
      const mockDeps = {
        sessionDb: {
          getSession: () =>
            Promise.resolve({
              session: "test",
              taskId: "test",
              repoName: "test-repo",
              branch: "test",
              workspacePath: "/mock/workspace",
              sessionWorkspacePath: "/mock/workdir",
            }),
          updateSession: () => Promise.resolve(),
          listSessions: () => Promise.resolve([]),
        },
        getSessionWorkdir: () => "/mock/workdir",
        execInRepository: (workdir: string, command: string) => {
          if (command.includes(GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD)) {
            return Promise.resolve("pr/feature-branch"); // Different PR branch pattern
          }
          return Promise.resolve("");
        },
        push: () => Promise.resolve(),
      };

      await expect(
        preparePrImpl({ session: "test", title: "Test", body: "Test" }, mockDeps as any)
      ).rejects.toThrow(/Cannot create PR from PR branch 'pr\/feature-branch'/);
    });
  });
});
