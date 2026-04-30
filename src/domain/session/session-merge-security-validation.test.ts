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
        sessionId: "test-session",
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
        sessionId: "test-session",
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
        sessionId: "test-session",
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
        sessionId: "test-session",
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
        sessionId: "test-session",
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
        sessionId: SESSION_TEST_PATTERNS.UNAPPROVED_SESSION,
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
        sessionId: "no-pr-session",
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
        sessionId: SESSION_TEST_PATTERNS.APPROVED_SESSION,
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
        persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
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
      // test -- it verifies that unapproved sessions don't reach the merge API.
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

  // ── Acceptance tests for the acceptStaleReviewerSilence waiver (mt#1366) ────

  describe("acceptStaleReviewerSilence waiver", () => {
    // Shared test constants to avoid magic-string duplication
    const TEST_SESSION_WORKDIR = "/test/session/workdir";
    const COMMENT_NO_BLOCKERS = "No blockers found.";

    // Shared pullRequest object so tests can spread it without non-null assertions
    const botPullRequest = {
      number: 999,
      url: "https://github.com/test/repo/pull/999",
      state: "open" as const,
      createdAt: new Date().toISOString(),
      headBranch: "task/mt-1366",
      baseBranch: "main",
      lastSynced: new Date().toISOString(),
      github: {
        id: 999,
        nodeId: "PR_node_999",
        htmlUrl: "https://github.com/test/repo/pull/999",
        author: "minsky-ai[bot]",
      },
    };

    // Shared GitHub session record with a PR that has no approvals
    const botPrSession: SessionRecord = {
      sessionId: "bot-pr-session",
      repoName: "test/repo",
      createdAt: new Date().toISOString(),
      name: "bot-pr-session",
      taskId: "task-bot",
      repoUrl: "https://github.com/test/repo.git",
      backendType: "github",
      prBranch: "task/mt-1366",
      prApproved: true,
      pullRequest: botPullRequest,
    };

    const successMergeResult = {
      commitHash: "abc123def456",
      mergeDate: new Date().toISOString(),
      mergedBy: "test-user",
      mergeSha: "abc123",
      mergedAt: new Date().toISOString(),
    };

    const fakeDeps = (getApprovalStatusImpl: () => Promise<unknown>) => ({
      sessionDB: {
        ...mockSessionProvider,
        getSession: mock(() => Promise.resolve(botPrSession)),
        updateSession: mock(() => Promise.resolve()),
        getSessionWorkdir: mock(() => Promise.resolve(TEST_SESSION_WORKDIR)),
      },
      persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
      createRepositoryBackend: (_config: any) =>
        Promise.resolve({
          pr: { merge: mock(() => Promise.resolve(successMergeResult)) },
          review: { getApprovalStatus: mock(getApprovalStatusImpl) },
          getType: () => "github",
        } as any),
      taskService: {
        setTaskStatus: async () => {},
        getTaskStatus: async () => "IN-REVIEW",
        getTask: async () => null,
      } as any,
    });

    // Acceptance test 1 (default-blocked):
    // Same-identity COMMENT review, no minsky-reviewer[bot] review, no CHANGES_REQUESTED.
    // Without the flag: session_pr_merge still refuses with a clear message.
    it("Acceptance 1 (default): blocks merge without waiver flag when isApproved=false", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false,
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "minsky-ai[bot]",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: COMMENT_NO_BLOCKERS,
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      await expect(mergeSessionPr({ session: "bot-pr-session", json: true }, deps)).rejects.toThrow(
        ValidationError
      );

      await expect(mergeSessionPr({ session: "bot-pr-session", json: true }, deps)).rejects.toThrow(
        /does not meet approval requirements/
      );
    });

    // Acceptance test 1 (flag-allowed):
    // Same-identity COMMENT review, no minsky-reviewer[bot], no CHANGES_REQUESTED.
    // hasNonApprovalMergeBlockers=false: no draft, no merge conflicts, PR is open.
    // NOTE: canMerge=false here (realistic: isApproved=false means canMerge is always false).
    // The waiver check correctly uses hasNonApprovalMergeBlockers, NOT canMerge (B1 fix).
    // With acceptStaleReviewerSilence=true: merges successfully.
    it("Acceptance 1 (waiver): allows merge with flag when conditions hold and hasNonApprovalMergeBlockers=false", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false, // Realistic: always false when isApproved=false
        hasNonApprovalMergeBlockers: false, // No draft/conflict/closed blockers
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "minsky-ai[bot]",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: COMMENT_NO_BLOCKERS,
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      const result = await mergeSessionPr(
        { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
        deps
      );

      expect(result).toBeDefined();
      expect(result.session).toBe("bot-pr-session");
    });

    // Acceptance test 2:
    // Self-authored PR with CHANGES_REQUESTED review: still blocked regardless of flag.
    it("Acceptance 2: blocks merge even with flag when CHANGES_REQUESTED exists", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false,
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "minsky-ai[bot]",
            state: "CHANGES_REQUESTED",
            submittedAt: new Date().toISOString(),
            body: "Fix the issue first.",
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(/CHANGES_REQUESTED review exists/);
    });

    // Acceptance test 3:
    // Self-authored PR with minsky-reviewer[bot] APPROVE review: merges normally without flag.
    it("Acceptance 3: merges normally when minsky-reviewer[bot] has approved (no flag needed)", async () => {
      const approvalStatus = {
        isApproved: true,
        canMerge: true,
        hasNonApprovalMergeBlockers: false,
        approvals: [
          {
            reviewId: "r2",
            approvedBy: "minsky-reviewer[bot]",
            approvedAt: new Date().toISOString(),
            prNumber: 999,
          },
        ],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r2",
            reviewerLogin: "minsky-reviewer[bot]",
            state: "APPROVED",
            submittedAt: new Date().toISOString(),
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      // No waiver flag needed: normal approval path
      const result = await mergeSessionPr({ session: "bot-pr-session", json: true }, deps);

      expect(result).toBeDefined();
      expect(result.session).toBe("bot-pr-session");
    });

    // B1 acceptance test (round-4):
    // Non-bot PR author with acceptStaleReviewerSilence=true is still blocked.
    // The waiver only applies when PR author is minsky-ai[bot].
    it("B1: blocks merge when PR author is not minsky-ai[bot] even with waiver flag", async () => {
      // Build a session with a non-bot PR author by spreading the shared pullRequest object
      const nonBotPrSession: SessionRecord = {
        ...botPrSession,
        pullRequest: {
          ...botPullRequest,
          github: {
            ...botPullRequest.github,
            author: "human-developer", // NOT minsky-ai[bot]
          },
        },
      };

      const approvalStatus = {
        isApproved: false,
        canMerge: false,
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "human-developer",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: "Looks good to me.",
          },
        ],
      };

      // Build deps with non-bot session
      const nonBotDeps = {
        sessionDB: {
          ...mockSessionProvider,
          getSession: mock(() => Promise.resolve(nonBotPrSession)),
          updateSession: mock(() => Promise.resolve()),
          getSessionWorkdir: mock(() => Promise.resolve(TEST_SESSION_WORKDIR)),
        },
        persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
        createRepositoryBackend: (_config: any) =>
          Promise.resolve({
            pr: { merge: mock(() => Promise.resolve(successMergeResult)) },
            review: { getApprovalStatus: mock(() => Promise.resolve(approvalStatus)) },
            getType: () => "github",
          } as any),
        taskService: {
          setTaskStatus: async () => {},
          getTaskStatus: async () => "IN-REVIEW",
          getTask: async () => null,
        } as any,
      };

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          nonBotDeps
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          nonBotDeps
        )
      ).rejects.toThrow(/not minsky-ai\[bot\]/);
    });

    // B2 acceptance test (round-4):
    // Third-party COMMENTED review with acceptStaleReviewerSilence=true is still blocked.
    // The waiver requires the COMMENTED review to be from the SAME identity as the PR author.
    it("B2-review: blocks merge when COMMENTED review is from a third party, not the PR author", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false,
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            // Third-party reviewer, NOT the PR author (minsky-ai[bot])
            reviewerLogin: "some-other-reviewer",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: "I had a look.",
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(/same-identity COMMENT review/);
    });

    // B2 acceptance test (round-4 NEW -- hasNonApprovalMergeBlockers check):
    // Waiver conditions (reviews) hold, but PR has hasNonApprovalMergeBlockers=true due to a
    // non-approval blocker (e.g. draft state, merge conflicts). Waiver must be refused.
    // NOTE: canMerge=false here, but that is not what the implementation checks (B1 fix).
    //       The implementation checks hasNonApprovalMergeBlockers which is true for draft PRs.
    it("B2-canMerge: blocks merge when waiver conditions hold but hasNonApprovalMergeBlockers=true", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false, // Realistic: always false when isApproved=false
        hasNonApprovalMergeBlockers: true, // Draft PR is a non-approval blocker
        nonApprovalBlockerDescription: "draft PR",
        approvals: [],
        requiredApprovals: 1,
        prState: "draft" as const, // PR is a draft (B3: correctly surfaced)
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "minsky-ai[bot]",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: COMMENT_NO_BLOCKERS,
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        mergeSessionPr(
          { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
          deps
        )
      ).rejects.toThrow(/Another merge blocker is active/);
    });

    // DISMISSED CHANGES_REQUESTED test:
    // A DISMISSED CHANGES_REQUESTED review should not block the waiver path.
    it("Non-blocking: dismissed CHANGES_REQUESTED does not block waiver", async () => {
      const approvalStatus = {
        isApproved: false,
        canMerge: false, // Realistic: always false when isApproved=false
        hasNonApprovalMergeBlockers: false, // No draft/conflict blockers
        approvals: [],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "minsky-ai[bot]",
            state: "DISMISSED", // Previously CHANGES_REQUESTED, now dismissed
            submittedAt: new Date().toISOString(),
            body: "Old comment, now dismissed.",
          },
          {
            reviewId: "r2",
            reviewerLogin: "minsky-ai[bot]",
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            body: COMMENT_NO_BLOCKERS,
          },
        ],
      };

      const deps = fakeDeps(() => Promise.resolve(approvalStatus));

      // DISMISSED review should not block the waiver -- merge should succeed
      const result = await mergeSessionPr(
        { session: "bot-pr-session", json: true, acceptStaleReviewerSilence: true },
        deps
      );

      expect(result).toBeDefined();
      expect(result.session).toBe("bot-pr-session");
    });
  });
});
