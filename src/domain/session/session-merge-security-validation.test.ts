/**
 * Security Test: Session Merge Approval Validation (Task #358)
 *
 * CRITICAL SECURITY REQUIREMENT: NO MERGE OPERATIONS SHALL BE ALLOWED
 * WITHOUT PROPER PR APPROVAL VALIDATION
 *
 * This test ensures that all merge pathways properly validate approval state
 * before allowing any merge operation to proceed.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  mergeSessionPr,
  validateSessionApprovedForMerge,
  type SessionMergeParams,
} from "./session-merge-operations";
import { ValidationError } from "../../errors/index";
import type { SessionRecord } from "./types";
import { SESSION_TEST_PATTERNS } from "../../utils/test-utils/test-constants";

// Mock dependencies
const mockSessionProvider = {
  listSessions: mock(() => Promise.resolve([])),
  getSession: mock(),
  getSessionByTaskId: mock(),
  addSession: mock(() => Promise.resolve()),
  updateSession: mock(),
  deleteSession: mock(() => Promise.resolve(true)),
  getRepoPath: mock(() => Promise.resolve("/test/repo/path")),
  getSessionWorkdir: mock(() => Promise.resolve("/test/session/workdir")),
};

const mockRepositoryBackend = {
  mergePullRequest: mock(),
  approvePullRequest: mock(),
  getPullRequestApprovalStatus: mock(),
  getType: () => "test-backend",
};

describe("Session Merge Security Validation", () => {
  // Mock modules for Bun test
  mock.module("./session-db-adapter", () => ({
    createSessionProvider: () => mockSessionProvider,
  }));

  mock.module("./repository-backend-detection", () => ({
    createRepositoryBackendForSession: () => mockRepositoryBackend,
  }));
  beforeEach(() => {
    // Reset mock call counts for each test
    mockSessionProvider.getSession.mockClear?.();
    mockSessionProvider.updateSession.mockClear?.();
    mockSessionProvider.getSessionByTaskId.mockClear?.();
    mockRepositoryBackend.mergePullRequest.mockClear?.();
    mockRepositoryBackend.approvePullRequest.mockClear?.();
    mockRepositoryBackend.getPullRequestApprovalStatus.mockClear?.();
  });

  describe("validateSessionApprovedForMerge", () => {
    it("should REJECT merge when prBranch is missing", () => {
      // SECURITY TEST: Missing PR branch should block merge
      const sessionRecord: SessionRecord = {
        name: "test-session",
        taskId: "task-123",
        repoUrl: "/test/repo",
        // prBranch: undefined - missing!
        prApproved: true,
      };

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(ValidationError);

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(/MERGE REJECTED.*has no PR branch/);
    });

    it("should REJECT merge when prApproved is false", () => {
      // SECURITY TEST: Unapproved PR should block merge
      const sessionRecord: SessionRecord = {
        name: "test-session",
        taskId: "task-123",
        repoUrl: "/test/repo",
        prBranch: "pr/test-session",
        prApproved: false, // UNAPPROVED!
      };

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(ValidationError);

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(/PR must be approved/);
    });

    it("should REJECT merge when prApproved is undefined", () => {
      // SECURITY TEST: Undefined approval should block merge
      const sessionRecord: SessionRecord = {
        name: "test-session",
        taskId: "task-123",
        repoUrl: "/test/repo",
        prBranch: "pr/test-session",
        // prApproved: undefined - missing!
      };

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(ValidationError);

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(/PR must be approved/);
    });

    it("should REJECT merge when prApproved is truthy but not boolean true", () => {
      // SECURITY TEST: Non-boolean truthy values should be rejected
      const sessionRecord: SessionRecord = {
        name: "test-session",
        taskId: "task-123",
        repoUrl: "/test/repo",
        prBranch: "pr/test-session",
        prApproved: "yes" as any, // Truthy but not boolean true!
      };

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(ValidationError);

      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).toThrow(/PR must be approved before merging/);
    });

    it("should ALLOW merge only when both prBranch and prApproved are properly set", () => {
      // SECURITY TEST: Only valid approval state should allow merge
      const sessionRecord: SessionRecord = {
        name: "test-session",
        taskId: "task-123",
        repoUrl: "/test/repo",
        prBranch: "pr/test-session",
        prApproved: true, // PROPERLY APPROVED
      };

      // This should NOT throw
      expect(() => {
        validateSessionApprovedForMerge(sessionRecord, "test-session");
      }).not.toThrow();
    });
  });

  describe("mergeSessionPr - End-to-End Security Validation", () => {
    it("should REJECT merge operation for unapproved session", async () => {
      // SECURITY TEST: Full merge operation should be blocked for unapproved PR
      const unapprovedSession: SessionRecord = {
        name: "unapproved-session",
        taskId: "task-456",
        repoUrl: "/test/repo",
        prBranch: "pr/unapproved-session",
        prApproved: false, // UNAPPROVED!
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(unapprovedSession));

      const params: SessionMergeParams = {
        session: "unapproved-session",
        json: false,
      };

      // The merge operation should be REJECTED
      await expect(mergeSessionPr(params, { sessionDB: mockSessionProvider })).rejects.toThrow(
        ValidationError
      );
      await expect(mergeSessionPr(params, { sessionDB: mockSessionProvider })).rejects.toThrow(
        /PR must be approved/
      );

      // Repository backend should NEVER be called for unapproved sessions
      expect(mockRepositoryBackend.mergePullRequest).not.toHaveBeenCalled();
    });

    it("should REJECT merge operation for session with no PR branch", async () => {
      // SECURITY TEST: Session without PR should be blocked
      const noPrSession: SessionRecord = {
        name: "no-pr-session",
        taskId: "task-789",
        repoUrl: "/test/repo",
        // prBranch: undefined - no PR!
        // prApproved: undefined
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(noPrSession));

      const params: SessionMergeParams = {
        session: "no-pr-session",
        json: false,
      };

      // The merge operation should be REJECTED
      await expect(mergeSessionPr(params, { sessionDB: mockSessionProvider })).rejects.toThrow(
        ValidationError
      );
      await expect(mergeSessionPr(params, { sessionDB: mockSessionProvider })).rejects.toThrow(
        /has no PR branch/
      );

      // Repository backend should NEVER be called for sessions without PR
      expect(mockRepositoryBackend.mergePullRequest).not.toHaveBeenCalled();
    });

    it("should ALLOW merge operation only for properly approved sessions", async () => {
      // SECURITY TEST: Only properly approved sessions should proceed to merge
      const approvedSession: SessionRecord = {
        name: SESSION_TEST_PATTERNS.APPROVED_SESSION,
        taskId: "task-999",
        repoUrl: "/test/repo",
        prBranch: "pr/approved-session",
        prApproved: true, // PROPERLY APPROVED
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(approvedSession));
      mockRepositoryBackend.mergePullRequest = mock(() =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: new Date().toISOString(),
          mergedBy: "test-user",
          mergeSha: "abc123",
          mergedAt: new Date().toISOString(),
        })
      );

      const params: SessionMergeParams = {
        session: SESSION_TEST_PATTERNS.APPROVED_SESSION,
        json: false,
      };

      // This should succeed and call the repository backend
      const result = await mergeSessionPr(params, {
        sessionDB: mockSessionProvider,
        createRepositoryBackend: () => Promise.resolve(mockRepositoryBackend),
      });

      expect(result).toBeDefined();
      expect(result.session).toBe(SESSION_TEST_PATTERNS.APPROVED_SESSION);
      expect(result.taskId).toBe("task-999");

      // Repository backend should be called for approved sessions
      expect(mockRepositoryBackend.mergePullRequest).toHaveBeenCalledWith(
        "pr/approved-session",
        SESSION_TEST_PATTERNS.APPROVED_SESSION
      );
    });
  });

  describe("Security Edge Cases", () => {
    it("should handle malicious approval state manipulation", () => {
      // SECURITY TEST: Prevent bypass via object manipulation
      const maliciousSession = {
        name: "malicious-session",
        taskId: "task-evil",
        repoUrl: "/test/repo",
        prBranch: "pr/malicious-session",
        prApproved: { valueOf: () => true }, // Object that's truthy but not boolean true
      } as any;

      expect(() => {
        validateSessionApprovedForMerge(maliciousSession, "malicious-session");
      }).toThrow(ValidationError);
    });

    it("should handle null and undefined edge cases", () => {
      // SECURITY TEST: Null/undefined safety
      const edgeCaseSession = {
        name: "edge-case-session",
        taskId: "task-edge",
        repoUrl: "/test/repo",
        prBranch: null,
        prApproved: null,
      } as any;

      expect(() => {
        validateSessionApprovedForMerge(edgeCaseSession, "edge-case-session");
      }).toThrow(ValidationError);
    });
  });
});
