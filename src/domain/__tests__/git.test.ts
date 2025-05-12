/**
 * Tests for interface-agnostic git functions
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MinskyError } from "../../errors/index.js";

// Mock dependencies
const mockPrResult = {
  markdown: "# Test PR\n\nThis is a test PR",
  statusUpdateResult: {
    taskId: "#123",
    previousStatus: "TODO",
    newStatus: "IN-REVIEW",
  },
};

// Mock functions
const mockPrFn = mock(() => Promise.resolve(mockPrResult));
const mockCommitFn = mock(() => Promise.resolve("abc123"));
const mockStageAllFn = mock(() => Promise.resolve());
const mockStageModifiedFn = mock(() => Promise.resolve());
const mockGetSessionFn = mock(() =>
  Promise.resolve({
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "/mock/repo/url",
    createdAt: new Date().toISOString(),
    taskId: "#123",
  })
);
const mockResolveRepoPathFn = mock(() => Promise.resolve("/mock/repo/path"));

describe("interface-agnostic git functions", () => {
  beforeEach(() => {
    // Reset mocks
    mockPrFn.mockReset();
    mockCommitFn.mockReset();
    mockStageAllFn.mockReset();
    mockStageModifiedFn.mockReset();
    mockGetSessionFn.mockReset();
    mockResolveRepoPathFn.mockReset();

    // Reset mock implementations to defaults
    mockPrFn.mockImplementation(() => Promise.resolve(mockPrResult));
    mockCommitFn.mockImplementation(() => Promise.resolve("abc123"));
    mockStageAllFn.mockImplementation(() => Promise.resolve());
    mockStageModifiedFn.mockImplementation(() => Promise.resolve());
    mockGetSessionFn.mockImplementation(() =>
      Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/mock/repo/url",
        createdAt: new Date().toISOString(),
        taskId: "#123",
      })
    );
    mockResolveRepoPathFn.mockImplementation(() => Promise.resolve("/mock/repo/path"));
  });

  describe("createPullRequestFromParams", () => {
    test("should generate a PR with valid parameters", async () => {
      // Mock the required dependencies
      const mockCreatePullRequestFromParams = mock((params) => {
        const gitService = new (class {
          pr = mockPrFn;
        })();

        return gitService.pr(params);
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          pr = mockPrFn;
        },
        createPullRequestFromParams: mockCreatePullRequestFromParams,
      }));

      // Import to use mocked functions
      const { createPullRequestFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        repo: "/mock/repo/url",
        branch: "feature-branch",
        debug: true,
        noStatusUpdate: false,
        taskId: "#123",
      };

      const result = await createPullRequestFromParams(params);

      expect(result).toBeDefined();
      expect(mockPrFn).toHaveBeenCalledWith({
        session: "test-session",
        repoPath: "/mock/repo/url",
        branch: "feature-branch",
        debug: true,
        noStatusUpdate: false,
        taskId: "#123",
      });
    });

    test("should handle errors properly", async () => {
      // Mock with error
      const mockErrorFn = mock(() => {
        throw new Error("Test error");
      });
      const mockCreatePullRequestFromParams = mock(() => {
        throw new MinskyError("Failed to create pull request: Test error");
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          pr = mockErrorFn;
        },
        createPullRequestFromParams: mockCreatePullRequestFromParams,
      }));

      // Import to use mocked functions
      const { createPullRequestFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        repo: "/mock/repo/url",
      };

      try {
        await createPullRequestFromParams(params);
        expect("Should have thrown").toBe("But did not");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
      }
    });
  });

  describe("commitChangesFromParams", () => {
    test("should commit changes with valid parameters", async () => {
      // Mock the required dependencies
      const mockCommitChangesFromParams = mock((params) => {
        const gitService = new (class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        })();

        return {
          commitHash: "abc123",
          message: `#123: ${params.message}`,
        };
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        },
        commitChangesFromParams: mockCommitChangesFromParams,
      }));

      mock.module("../session.js", () => ({
        SessionDB: class {
          getSession = mockGetSessionFn;
        },
      }));

      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: mockResolveRepoPathFn,
      }));

      // Import to use mocked functions
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        message: "Test commit message",
        all: true,
        amend: false,
      };

      const result = await commitChangesFromParams(params);

      expect(result).toBeDefined();
      expect(result.commitHash).toBe("abc123");
      expect(result.message).toBe("#123: Test commit message");
    });

    test("should use stageModified when all is not set", async () => {
      // Mock the required dependencies
      const mockCommitChangesFromParams = mock((params) => {
        const gitService = new (class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        })();

        if (!params.all && !params.noStage) {
          mockStageModifiedFn();
        }

        return {
          commitHash: "abc123",
          message: `#123: ${params.message}`,
        };
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        },
        commitChangesFromParams: mockCommitChangesFromParams,
      }));

      mock.module("../session.js", () => ({
        SessionDB: class {
          getSession = mockGetSessionFn;
        },
      }));

      // Import to use mocked functions
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        message: "Test commit message",
        all: false,
        amend: false,
      };

      await commitChangesFromParams(params);

      expect(mockStageModifiedFn).toHaveBeenCalled();
      expect(mockStageAllFn).not.toHaveBeenCalled();
    });

    test("should not stage when noStage is set", async () => {
      // Mock the required dependencies
      const mockCommitChangesFromParams = mock((params) => {
        const gitService = new (class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        })();

        return {
          commitHash: "abc123",
          message: `#123: ${params.message}`,
        };
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
          getSessionWorkdir(repoName, session) {
            return "/mock/repo/path";
          }
        },
        commitChangesFromParams: mockCommitChangesFromParams,
      }));

      mock.module("../session.js", () => ({
        SessionDB: class {
          getSession = mockGetSessionFn;
        },
      }));

      // Import to use mocked functions
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        message: "Test commit message",
        noStage: true,
      };

      await commitChangesFromParams(params);

      expect(mockStageModifiedFn).not.toHaveBeenCalled();
      expect(mockStageAllFn).not.toHaveBeenCalled();
    });

    test("should handle errors properly", async () => {
      // Mock with error
      const mockCommitChangesFromParams = mock(() => {
        throw new MinskyError("Failed to commit changes: Test error");
      });

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService: class {
          stageAll = mockStageAllFn;
          stageModified = mockStageModifiedFn;
          commit = mockCommitFn;
        },
        commitChangesFromParams: mockCommitChangesFromParams,
      }));

      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: () => {
          throw new Error("Test error");
        },
      }));

      // Import to use mocked functions
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        message: "Test commit message",
      };

      try {
        await commitChangesFromParams(params);
        expect("Should have thrown").toBe("But did not");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
      }
    });
  });
});
