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
  type SessionProviderInterface
} from "./session";
import { type GitServiceInterface } from "./git";
import { createMockSessionProvider, createMockGitService } from "../utils/test-utils/index";

// Mock session DB helper for this specific test's needs
const createMockSessionDBWithHelpers = () => {
  const sessions = new Map<string, any>();
  
  const mockSessionDB = createMockSessionProvider({
    getSession: (sessionName: string) => Promise.resolve(sessions.get(sessionName) || null),
  });
  
  // Override updateSession with custom logic for this test
  (mockSessionDB as any).updateSession = (sessionName: string, updates: any) => {
    const existing = sessions.get(sessionName) || {};
    sessions.set(sessionName, { ...existing, ...updates });
    return Promise.resolve();
  };
  
  // Add helper method for test setup
  (mockSessionDB as any)._setSession = (sessionName: string, data: any) => {
    sessions.set(sessionName, data);
  };
  
  return mockSessionDB;
};

const createMockGitServiceWithCallTracking = (branchExists: boolean = true) => {
  let gitCallCount = 0;
  
  const mockGitService = createMockGitService({
    execInRepository: (workdir: string, command: string) => {
      gitCallCount++;
      if (command.includes("show-ref") && command.includes("pr/")) {
        return Promise.resolve(branchExists ? "ref-exists" : "not-exists");
      }
      if (command.includes("ls-remote") && command.includes("pr/")) {
        return Promise.resolve(branchExists ? "remote-ref-exists" : "");
      }
      return Promise.resolve("");
    },
  });
  
  // Add call tracking methods
  (mockGitService as any).getGitCallCount = () => gitCallCount;
  (mockGitService as any).resetGitCallCount = () => { gitCallCount = 0; };
  
  return mockGitService;
};

describe("PR State Optimization (Task #275)", () => {
  let mockSessionDB: any;
  let mockGitService: any;
  
  beforeEach(() => {
    mockSessionDB = createMockSessionDBWithHelpers();
    mockGitService = createMockGitServiceWithCallTracking(true);
  });

  describe("checkPrBranchExistsOptimized", () => {
    test("should use cached PR state when available and not stale", async () => {
      const sessionName = "test-session";
      const now = new Date().toISOString();
      
      // Set up session with fresh PR state
      mockSessionDB._setSession(sessionName, {
        session: sessionName,
        prState: {
          branchName: "pr/test-session",
          exists: true,
          lastChecked: now,
          createdAt: now
        }
      });
      
      mockGitService.resetGitCallCount();
      
      const result = await checkPrBranchExistsOptimized(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      
      expect(result).toBe(true);
      expect(mockGitService.getGitCallCount()).toBe(0); // No git calls should be made
    });

    test("should refresh stale PR state", async () => {
      const sessionName = "test-session";
      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
      
      // Set up session with stale PR state
      mockSessionDB._setSession(sessionName, {
        session: sessionName,
        prState: {
          branchName: "pr/test-session",
          exists: true,
          lastChecked: staleTime,
          createdAt: staleTime
        }
      });
      
      mockGitService.resetGitCallCount();
      
      const result = await checkPrBranchExistsOptimized(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      
      expect(result).toBe(true);
      expect(mockGitService.getGitCallCount()).toBeGreaterThan(0); // Git calls should be made to refresh
    });

    test("should fall back to git operations when no session record exists", async () => {
      const sessionName = "non-existent-session";
      
      mockGitService.resetGitCallCount();
      
      const result = await checkPrBranchExistsOptimized(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      
      expect(result).toBe(true);
      expect(mockGitService.getGitCallCount()).toBeGreaterThan(0); // Git calls should be made
    });

    test("should provide significant performance improvement", async () => {
      const sessionName = "performance-test";
      const now = new Date().toISOString();
      
      // Set up session with fresh PR state
      mockSessionDB._setSession(sessionName, {
        session: sessionName,
        prState: {
          branchName: "pr/performance-test",
          exists: true,
          lastChecked: now,
          createdAt: now
        }
      });
      
      // Test original function (multiple git calls)
      mockGitService.resetGitCallCount();
      await checkPrBranchExists(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir"
      );
      const originalGitCalls = mockGitService.getGitCallCount();
      
      // Test optimized function (cached state)
      mockGitService.resetGitCallCount();
      await checkPrBranchExistsOptimized(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      const optimizedGitCalls = mockGitService.getGitCallCount();
      
      expect(optimizedGitCalls).toBe(0); // No git calls
      expect(originalGitCalls).toBeGreaterThan(0); // Git calls made
      
      // Performance improvement is demonstrated by elimination of git operations
      expect(optimizedGitCalls).toBeLessThan(originalGitCalls);
    });
  });

  describe("updatePrStateOnCreation", () => {
    test("should create PR state when PR branch is created", async () => {
      const sessionName = "new-pr-session";
      
      await updatePrStateOnCreation(sessionName, mockSessionDB as SessionProviderInterface);
      
      const session = await mockSessionDB.getSession(sessionName);
      expect(session.prState).toBeDefined();
      expect(session.prState.branchName).toBe("pr/new-pr-session");
      expect(session.prState.exists).toBe(true);
      expect(session.prState.createdAt).toBeDefined();
      expect(session.prState.lastChecked).toBeDefined();
      expect(session.prState.mergedAt).toBeUndefined();
    });
  });

  describe("updatePrStateOnMerge", () => {
    test("should update PR state when PR is merged", async () => {
      const sessionName = "merge-test-session";
      const now = new Date().toISOString();
      
      // Set up session with existing PR state
      mockSessionDB._setSession(sessionName, {
        session: sessionName,
        prState: {
          branchName: "pr/merge-test-session",
          exists: true,
          lastChecked: now,
          createdAt: now
        }
      });
      
      await updatePrStateOnMerge(sessionName, mockSessionDB as SessionProviderInterface);
      
      const session = await mockSessionDB.getSession(sessionName);
      expect(session.prState.exists).toBe(false);
      expect(session.prState.mergedAt).toBeDefined();
    });

    test("should handle missing PR state gracefully", async () => {
      const sessionName = "no-pr-state-session";
      
      // Set up session without PR state
      mockSessionDB._setSession(sessionName, {
        session: sessionName
      });
      
      // Should not throw error
      await expect(async () => {
        await updatePrStateOnMerge(sessionName, mockSessionDB as SessionProviderInterface);
      }).not.toThrow();
    });
  });

  describe("Integration with existing workflow", () => {
    test("should maintain backward compatibility", async () => {
      const sessionName = "backward-compat-test";
      
      // Test that original function still works
      const originalResult = await checkPrBranchExists(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir"
      );
      
      // Test that optimized function falls back correctly
      const optimizedResult = await checkPrBranchExistsOptimized(
        sessionName,
        mockGitService as GitServiceInterface,
        "/test/dir",
        mockSessionDB as SessionProviderInterface
      );
      
      expect(originalResult).toBe(optimizedResult);
    });
  });
}); 
