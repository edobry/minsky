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

const mockTaskService = {
  setTaskStatus: async () => {},
  getTaskStatus: async () => "IN-REVIEW",
  getTask: async () => null,
} as any;

const mockMerge = mock();
const mockApprove = mock();
const mockGetApprovalStatus = mock();
const mockRepositoryBackend = {
  pr: {
    merge: mockMerge,
  },
  review: {
    approve: mockApprove,
    getApprovalStatus: mockGetApprovalStatus,
  },
  getType: () => "test-backend",
};

describe("Session Merge Security Validation", () => {
  beforeEach(() => {
    // Reset mock call counts for each test
    mockSessionProvider.getSession.mockClear?.();
    mockSessionProvider.updateSession.mockClear?.();
    mockSessionProvider.getSessionByTaskId.mockClear?.();
    mockMerge.mockClear?.();
    mockApprove.mockClear?.();
    mockGetApprovalStatus.mockClear?.();
  });

  describe("validateSessionApprovedForMerge", () => {
    it("should REJECT merge when prBranch is missing", () => {
      // SECURITY TEST: Missing PR branch should block merge
      const sessionRecord: SessionRecord = {
        session: "test-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "test-session",
        taskId: "task-123",
        repoUrl: "https://github.com/test/repo.git",
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
        session: "test-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "test-session",
        taskId: "task-123",
        repoUrl: "https://github.com/test/repo.git",
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
        session: "test-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "test-session",
        taskId: "task-123",
        repoUrl: "https://github.com/test/repo.git",
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
        session: "test-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "test-session",
        taskId: "task-123",
        repoUrl: "https://github.com/test/repo.git",
        prBranch: "pr/test-session",
        prApproved: "yes" as unknown as boolean, // Truthy but not boolean true!
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
        session: "test-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "test-session",
        taskId: "task-123",
        repoUrl: "https://github.com/test/repo.git",
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
        session: SESSION_TEST_PATTERNS.UNAPPROVED_SESSION,
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: SESSION_TEST_PATTERNS.UNAPPROVED_SESSION,
        taskId: "task-456",
        repoUrl: "https://github.com/test/repo.git",
        prBranch: `pr/${SESSION_TEST_PATTERNS.UNAPPROVED_SESSION}`,
        prApproved: false, // UNAPPROVED!
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(unapprovedSession));

      const params: SessionMergeParams = {
        session: SESSION_TEST_PATTERNS.UNAPPROVED_SESSION,
        json: false,
      };

      // The merge operation should be REJECTED
      await expect(
        mergeSessionPr(params, { sessionDB: mockSessionProvider, taskService: mockTaskService })
      ).rejects.toThrow(ValidationError);
      await expect(
        mergeSessionPr(params, { sessionDB: mockSessionProvider, taskService: mockTaskService })
      ).rejects.toThrow(/PR must be approved/);

      // Repository backend should NEVER be called for unapproved sessions
      expect(mockMerge).not.toHaveBeenCalled();
    });

    it("should REJECT merge operation for session with no PR branch", async () => {
      // SECURITY TEST: Session without PR should be blocked
      const noPrSession: SessionRecord = {
        session: "no-pr-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "no-pr-session",
        taskId: "task-789",
        repoUrl: "https://github.com/test/repo.git",
        // prBranch: undefined - no PR!
        // prApproved: undefined
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(noPrSession));

      const params: SessionMergeParams = {
        session: "no-pr-session",
        json: false,
      };

      // The merge operation should be REJECTED
      await expect(
        mergeSessionPr(params, { sessionDB: mockSessionProvider, taskService: mockTaskService })
      ).rejects.toThrow(ValidationError);
      await expect(
        mergeSessionPr(params, { sessionDB: mockSessionProvider, taskService: mockTaskService })
      ).rejects.toThrow(/has no PR branch/);

      // Repository backend should NEVER be called for sessions without PR
      expect(mockMerge).not.toHaveBeenCalled();
    });

    it("should ALLOW merge operation only for properly approved sessions", async () => {
      // SECURITY TEST: Only properly approved sessions should proceed to merge
      const approvedSession: SessionRecord = {
        session: SESSION_TEST_PATTERNS.APPROVED_SESSION,
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: SESSION_TEST_PATTERNS.APPROVED_SESSION,
        taskId: "task-999",
        repoUrl: "https://github.com/test/repo.git",
        prBranch: "pr/approved-session",
        prApproved: true, // PROPERLY APPROVED
      };

      mockSessionProvider.getSession = mock(() => Promise.resolve(approvedSession));
      const newMerge = mock(() =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: new Date().toISOString(),
          mergedBy: "test-user",
          mergeSha: "abc123",
          mergedAt: new Date().toISOString(),
        })
      );
      (mockRepositoryBackend.pr as any).merge = newMerge;

      const params: SessionMergeParams = {
        session: SESSION_TEST_PATTERNS.APPROVED_SESSION,
        json: false,
      };

      // This should succeed and call the repository backend
      const result = await mergeSessionPr(params, {
        sessionDB: mockSessionProvider,
        createRepositoryBackend: (_config: any) => Promise.resolve(mockRepositoryBackend as any),
        taskService: {
          setTaskStatus: async () => {},
          getTaskStatus: async () => "IN-REVIEW",
          getTask: async () => null,
        } as any,
      });

      expect(result).toBeDefined();
      expect(result.session).toBe(SESSION_TEST_PATTERNS.APPROVED_SESSION);
      expect(result.taskId).toBe("task-999");

      // Repository backend should be called for approved sessions.
      // Third argument (MergePROptions) varies by runtime context (service-account
      // config, provenance records) and is tested in
      // src/domain/provenance/merge-token-resolution.test.ts. This is a security
      // test — it verifies that unapproved sessions don't reach the merge API.
      expect(newMerge).toHaveBeenCalledWith(
        "pr/approved-session",
        SESSION_TEST_PATTERNS.APPROVED_SESSION,
        expect.anything()
      );
    });
  });

  describe("Security Edge Cases", () => {
    it("should handle malicious approval state manipulation", () => {
      // SECURITY TEST: Prevent bypass via object manipulation
      const maliciousSession = {
        name: "malicious-session",
        taskId: "task-evil",
        repoUrl: "https://github.com/test/repo.git",
        prBranch: "pr/malicious-session",
        prApproved: { valueOf: () => true }, // Object that's truthy but not boolean true
      } as unknown as SessionRecord;

      expect(() => {
        validateSessionApprovedForMerge(maliciousSession, "malicious-session");
      }).toThrow(ValidationError);
    });

    it("should handle null and undefined edge cases", () => {
      // SECURITY TEST: Null/undefined safety
      const edgeCaseSession = {
        name: "edge-case-session",
        taskId: "task-edge",
        repoUrl: "https://github.com/test/repo.git",
        prBranch: null,
        prApproved: null,
      } as unknown as SessionRecord;

      expect(() => {
        validateSessionApprovedForMerge(edgeCaseSession, "edge-case-session");
      }).toThrow(ValidationError);
    });
  });
});
