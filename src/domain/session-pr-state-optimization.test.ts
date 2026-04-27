/**
 * Tests for PR state optimization in session management
 * Task #275: Store PR Existence in Session Records for Optimized Session Approval
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkPrBranchExists,
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  updatePrStateOnMerge,
  type SessionProviderInterface,
} from "./session";
import { type GitServiceInterface } from "./git";
import { FakeGitService } from "./git/fake-git-service";
import { FakeSessionProvider } from "./session/fake-session-provider";

// Mock session DB helper for this specific test's needs
type MockSessionDBWithHelpers = SessionProviderInterface & {
  _setSession: (sessionId: string, data: unknown) => void;
};

const createMockSessionDBWithHelpers = (): MockSessionDBWithHelpers => {
  const provider = new FakeSessionProvider();

  // Expose a helper to inject partial session data for test setup
  (provider as unknown as MockSessionDBWithHelpers)._setSession = (
    sessionId: string,
    data: unknown
  ) => {
    void provider.addSession(data as Parameters<typeof provider.addSession>[0]);
  };

  return provider as unknown as MockSessionDBWithHelpers;
};

const createMockGitServiceWithCallTracking = (branchExists: boolean = true): FakeGitService => {
  const fakeGit = new FakeGitService({ branchExists });
  fakeGit.execInRepository = (_workdir: string, command: string) => {
    fakeGit.recordedCommands.push({ workdir: _workdir, command });
    if (command.includes("show-ref") && command.includes("pr/")) {
      return Promise.resolve(branchExists ? "ref-exists" : "not-exists");
    }
    if (command.includes("ls-remote") && command.includes("pr/")) {
      return Promise.resolve(branchExists ? "remote-ref-exists" : "");
    }
    if (command.includes("rev-parse")) {
      return Promise.resolve(branchExists ? "abc123def456" : "");
    }
    return Promise.resolve("");
  };
  return fakeGit;
};

describe("PR State Optimization (Task #275)", () => {
  let mockSessionDB: MockSessionDBWithHelpers;
  let mockGitService: FakeGitService;

  beforeEach(() => {
    mockSessionDB = createMockSessionDBWithHelpers();
    mockGitService = createMockGitServiceWithCallTracking(true);
  });

  describe("checkPrBranchExistsOptimized", () => {
    test("should use cached PR state when available and not stale", async () => {
      const sessionId = "test-session";
      const now = new Date().toISOString();

      // Set up session with fresh PR state
      mockSessionDB._setSession(sessionId, {
        sessionId: sessionId,
        prState: {
          branchName: "pr/test-session",
          commitHash: "abc123def456", // Add commitHash since implementation checks this
          exists: true, // Required by checkPrBranchExistsOptimized implementation
          lastChecked: now,
          createdAt: now,
        },
      });

      mockGitService.resetCallCount();

      const result = await checkPrBranchExistsOptimized(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );

      expect(result).toBe(true);
      expect(mockGitService.callCount).toBe(0); // No git calls should be made
    });

    test("should refresh stale PR state", async () => {
      const sessionId = "test-session";
      const staleTime = new Date(1640995200000 - 10 * 60 * 1000).toISOString(); // Static mock time - 10 minutes ago

      // Set up session with stale PR state
      mockSessionDB._setSession(sessionId, {
        sessionId: sessionId,
        prState: {
          branchName: "pr/test-session",
          exists: true,
          lastChecked: staleTime,
          createdAt: staleTime,
        },
      });

      mockGitService.resetCallCount();

      const result = await checkPrBranchExistsOptimized(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );

      expect(result).toBe(true);
      expect(mockGitService.callCount).toBeGreaterThan(0); // Git calls should be made to refresh
    });

    test("should fall back to git operations when no session record exists", async () => {
      const sessionId = "non-existent-session";

      mockGitService.resetCallCount();

      const result = await checkPrBranchExistsOptimized(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );

      expect(result).toBe(true);
      expect(mockGitService.callCount).toBeGreaterThan(0); // Git calls should be made
    });

    test("should provide significant performance improvement", async () => {
      const sessionId = "performance-test";
      const now = new Date().toISOString();

      // Set up session with fresh PR state
      mockSessionDB._setSession(sessionId, {
        sessionId: sessionId,
        prState: {
          branchName: "pr/performance-test",
          exists: true,
          lastChecked: now,
          createdAt: now,
        },
      });

      // Test original function (multiple git calls)
      mockGitService.resetCallCount();
      await checkPrBranchExists(sessionId, mockGitService as GitServiceInterface, "/test/dir");
      const originalGitCalls = mockGitService.callCount;

      // Test optimized function (cached state)
      mockGitService.resetCallCount();
      await checkPrBranchExistsOptimized(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      const optimizedGitCalls = mockGitService.callCount;

      expect(optimizedGitCalls).toBe(0); // No git calls
      expect(originalGitCalls).toBeGreaterThan(0); // Git calls made

      // Performance improvement is demonstrated by elimination of git operations
      expect(optimizedGitCalls).toBeLessThan(originalGitCalls);
    });
  });

  describe("updatePrStateOnCreation", () => {
    test("should create PR state when PR branch is created", async () => {
      const sessionId = "new-pr-session";

      // Set up session record so updatePrStateOnCreation can find it
      mockSessionDB._setSession(sessionId, { sessionId: sessionId });

      await updatePrStateOnCreation(sessionId, mockSessionDB as SessionProviderInterface);

      const session = await mockSessionDB.getSession(sessionId);
      expect(session?.prState).toBeDefined();
      expect(session?.prState?.branchName).toBe("pr/new-pr-session");
      expect(session?.prState?.exists).toBe(true);
      expect(session?.prState?.createdAt).toBeDefined();
      expect(session?.prState?.lastChecked).toBeDefined();
      expect(session?.prState?.mergedAt).toBeUndefined();
    });
  });

  describe("updatePrStateOnMerge", () => {
    test("should update PR state when PR is merged", async () => {
      const sessionId = "merge-test-session";
      const now = new Date().toISOString();

      // Set up session with existing PR state
      mockSessionDB._setSession(sessionId, {
        sessionId: sessionId,
        prState: {
          branchName: "pr/merge-test-session",
          exists: true,
          lastChecked: now,
          createdAt: now,
        },
      });

      await updatePrStateOnMerge(sessionId, mockSessionDB as SessionProviderInterface);

      const session = await mockSessionDB.getSession(sessionId);
      expect(session?.prState?.exists).toBe(false);
      expect(session?.prState?.mergedAt).toBeDefined();
    });

    test("should handle missing PR state gracefully", async () => {
      const sessionId = "no-pr-state-session";

      // Set up session without PR state
      mockSessionDB._setSession(sessionId, {
        sessionId: sessionId,
      });

      // Should not throw error
      await expect(async () => {
        await updatePrStateOnMerge(sessionId, mockSessionDB as SessionProviderInterface);
      }).not.toThrow();
    });
  });

  describe("Integration with existing workflow", () => {
    test("should maintain backward compatibility", async () => {
      const sessionId = "backward-compat-test";

      // Test that original function still works
      const originalResult = await checkPrBranchExists(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir"
      );

      // Test that optimized function falls back correctly
      const optimizedResult = await checkPrBranchExistsOptimized(
        sessionId,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );

      expect(originalResult).toBe(optimizedResult);
    });
  });
});
