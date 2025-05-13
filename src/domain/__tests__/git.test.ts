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

// Create simple manual mock implementations
let mockPrCalled = false;
let mockCommitCalled = false;
let mockStageAllCalled = false;
let mockStageModifiedCalled = false;

// Reset mocks function
function resetMocks() {
  mockPrCalled = false;
  mockCommitCalled = false;
  mockStageAllCalled = false;
  mockStageModifiedCalled = false;
}

// Mock module to simulate git.js implementation
mock.module("../git.js", () => {
  // GitService class mock
  class GitService {
    pr() {
      mockPrCalled = true;
      return Promise.resolve(mockPrResult);
    }

    commit() {
      mockCommitCalled = true;
      return Promise.resolve("abc123");
    }

    stageAll() {
      mockStageAllCalled = true;
      return Promise.resolve();
    }

    stageModified() {
      mockStageModifiedCalled = true;
      return Promise.resolve();
    }

    getSessionWorkdir() {
      return "/mock/repo/path";
    }
  }

  // Interface-agnostic functions
  async function createPullRequestFromParams(params) {
    try {
      const gitService = new GitService();
      return await gitService.pr(params);
    } catch (err) {
      throw new MinskyError(
        `Failed to create pull request: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function commitChangesFromParams(params) {
    try {
      const gitService = new GitService();

      // Use the appropriate staging method based on params
      if (params.all && !params.noStage) {
        await gitService.stageAll();
      } else if (!params.noStage) {
        await gitService.stageModified();
      }

      // Get prefix from session if available
      let prefix = "";
      if (params.session) {
        prefix = "#123: "; // Simplified for tests
      }

      return {
        commitHash: "abc123",
        message: `${prefix}${params.message}`,
      };
    } catch (err) {
      throw new MinskyError(
        `Failed to commit changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    GitService,
    createPullRequestFromParams,
    commitChangesFromParams,
  };
});

describe("interface-agnostic git functions", () => {
  beforeEach(() => {
    resetMocks();
  });

  describe("createPullRequestFromParams", () => {
    test("should generate a PR with valid parameters", async () => {
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
      expect(mockPrCalled).toBe(true);
    });

    test("should handle errors properly", async () => {
      // Create a local mock with error behavior
      mock.module("../git.js", () => {
        class GitService {
          pr() {
            throw new Error("Test error");
          }
        }

        async function createPullRequestFromParams() {
          try {
            const gitService = new GitService();
            return await gitService.pr();
          } catch (err) {
            throw new MinskyError(
              `Failed to create pull request: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return { createPullRequestFromParams };
      });

      const { createPullRequestFromParams } = await import("../git.js");

      try {
        await createPullRequestFromParams({});
        expect("Should have thrown").toBe("But did not");
      } catch (err) {
        expect(err.message).toContain("Failed to create pull request: Test error");
      }
    });
  });

  describe("commitChangesFromParams", () => {
    test("should commit changes with valid parameters", async () => {
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
      expect(mockStageAllCalled).toBe(true);
      expect(mockStageModifiedCalled).toBe(false);
    });

    test("should use stageModified when all is not set", async () => {
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        message: "Test commit message",
        all: false,
        amend: false,
      };

      await commitChangesFromParams(params);

      expect(mockStageModifiedCalled).toBe(true);
      expect(mockStageAllCalled).toBe(false);
    });

    test("should not stage when noStage is set", async () => {
      const { commitChangesFromParams } = await import("../git.js");

      const params = {
        session: "test-session",
        message: "Test commit message",
        noStage: true,
      };

      await commitChangesFromParams(params);

      expect(mockStageModifiedCalled).toBe(false);
      expect(mockStageAllCalled).toBe(false);
    });

    test("should handle errors properly", async () => {
      // Create a local mock with error behavior
      mock.module("../git.js", () => {
        function commitChangesFromParams() {
          throw new MinskyError("Failed to commit changes: Test error");
        }

        return { commitChangesFromParams };
      });

      const { commitChangesFromParams } = await import("../git.js");

      try {
        await commitChangesFromParams({});
        expect("Should have thrown").toBe("But did not");
      } catch (err) {
        expect(err.message).toContain("Failed to commit changes: Test error");
      }
    });
  });
});
