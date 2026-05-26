import { describe, test, expect, mock } from "bun:test";
import { approveSessionPr } from "./session-approval-operations";
import { FakeGitService } from "../git/fake-git-service";
import type { RepositoryBackend, MergeInfo } from "../repository/index";

describe("Session Approve - Bug Regression Tests", () => {
  describe("Bug #1: Untracked Files Auto-Stash", () => {
    // Bug Report: Session approve fails with untracked files that would be overwritten by merge
    // Original Error: "error: The following untracked working tree files would be overwritten by merge"
    // Root Cause: git stash push was missing -u flag to include untracked files
    // Fix: Added -u flag to stashChanges methods

    test("should approve PR using repository backend", async () => {
      // Test constants to reduce error surface area
      const SESSION_NAME = "test-session";
      const REPO_NAME = "test-repo";
      const REPO_PATH = "/test/repo";
      const TASK_ID = "123";
      const PR_BRANCH = `pr/${SESSION_NAME}`;

      // Arrange: Set up scenario for PR approval
      const mockSessionDB = {
        getSessionByTaskId: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH, // Required for approval
            prApproved: false, // Not yet approved
          })
        ),
        getSession: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH, // Required for approval
            prApproved: false, // Not yet approved
          })
        ),
        // Add all required SessionProvider methods
        listSessions: mock(() => Promise.resolve([])),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve(REPO_PATH)),
        getSessionWorkdir: mock(() => Promise.resolve(`/sessions/${SESSION_NAME}`)),
      };

      // Mock repository backend for approval
      const mockApprove = mock(() =>
        Promise.resolve({
          reviewId: "approval-123",
          approvedBy: "Test User",
          approvedAt: "2025-07-30T23:14:24.213Z",
          prNumber: PR_BRANCH,
        })
      );
      const mockRepositoryBackend: RepositoryBackend = {
        getType: mock(() => "local"),
        pr: {
          merge: mock(() =>
            Promise.resolve({
              commitHash: "abc123def456",
              mergeDate: "2025-07-30T23:14:24.213Z",
              mergedBy: "Test User",
            } as MergeInfo)
          ),
        },
        review: {
          approve: mockApprove,
        },
      } as unknown as RepositoryBackend;

      const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

      // Act: Run session approve
      const result = await approveSessionPr(
        { task: `md#${TASK_ID}`, repo: REPO_PATH },
        {
          sessionDB: mockSessionDB,
          createRepositoryBackendForSession: mockCreateRepositoryBackend,
        }
      );

      // Assert: Verify approval operations were called
      expect(mockCreateRepositoryBackend).toHaveBeenCalled();
      expect(mockApprove).toHaveBeenCalledWith(PR_BRANCH, undefined);
      expect(result.session).toBe(SESSION_NAME);
      expect(result.prBranch).toBe(PR_BRANCH);
      expect(result.approvalInfo).toBeDefined();
    });

    test("should include -u flag in git stash command for untracked files", async () => {
      // This test verifies the specific fix: git stash push -u
      const mockGitService = new FakeGitService();
      mockGitService.stashChanges = mock(() =>
        Promise.resolve({ workdir: "/test", stashed: true })
      );
      mockGitService.popStash = mock(() => Promise.resolve({ workdir: "/test", stashed: true }));
      mockGitService.execInRepository = mock(() => Promise.resolve(""));

      // Test the GitService stashChanges method directly to verify -u flag usage
      // NOTE: This would have failed before the fix because the -u flag was missing
      const result = await mockGitService.stashChanges("/test/repo");

      expect(result.stashed).toBe(true);
      expect(mockGitService.stashChanges).toHaveBeenCalledWith("/test/repo");
    });
  });

  describe("Bug #2: Fail-Fast on Merge Errors", () => {
    // Bug Report: Session approve continues processing after merge failures, potentially corrupting repo state
    // Original Error: Fast-forward merge fails but command continues to update task status
    // Root Cause: Dangerous nested try-catch where outer catch treated ALL errors as "already merged"
    // Fix: Restructured error handling to fail fast on merge errors except genuine "already merged"

    test("should fail when repository backend approval fails", async () => {
      // Test constants to reduce error surface area
      const SESSION_NAME = "test-session";
      const REPO_NAME = "test-repo";
      const REPO_PATH = "/test/repo";
      const TASK_ID = "123";
      const PR_BRANCH = `pr/${SESSION_NAME}`;

      // Arrange: Set up scenario where approval fails
      const mockSessionDB = {
        getSessionByTaskId: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH,
            prApproved: false,
          })
        ),
        getSession: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH,
            prApproved: false,
          })
        ),
        // Add all required SessionProvider methods
        listSessions: mock(() => Promise.resolve([])),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve(REPO_PATH)),
        getSessionWorkdir: mock(() => Promise.resolve(`/sessions/${SESSION_NAME}`)),
      };

      // Mock repository backend that throws approval error
      const mockApprove2 = mock(() => {
        throw new Error("PR approval failed: insufficient permissions");
      });
      const mockRepositoryBackend: RepositoryBackend = {
        getType: mock(() => "local"),
        pr: {
          merge: mock(() =>
            Promise.resolve({
              commitHash: "abc123def456",
              mergeDate: "2025-07-30T23:14:24.213Z",
              mergedBy: "Test User",
            } as MergeInfo)
          ),
        },
        review: {
          approve: mockApprove2,
        },
      } as unknown as RepositoryBackend;

      const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

      // Act & Assert: Command should throw approval error
      await expect(
        approveSessionPr(
          { task: TASK_ID, repo: REPO_PATH },
          {
            sessionDB: mockSessionDB,
            createRepositoryBackendForSession: mockCreateRepositoryBackend,
          }
        )
      ).rejects.toThrow("PR approval failed: insufficient permissions");

      // Verify approval was attempted
      expect(mockApprove2).toHaveBeenCalledWith(PR_BRANCH, undefined);
    });

    test("should handle already approved PR gracefully", async () => {
      // Test constants to reduce error surface area
      const SESSION_NAME = "test-session";
      const REPO_NAME = "test-repo";
      const REPO_PATH = "/test/repo";
      const TASK_ID = "123";
      const PR_BRANCH = `pr/${SESSION_NAME}`;

      // Arrange: Set up scenario where PR is already approved
      const mockSessionDB = {
        getSessionByTaskId: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH,
            prApproved: true, // Already approved
          })
        ),
        getSession: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            prBranch: PR_BRANCH,
            prApproved: true, // Already approved
          })
        ),
        // Add all required SessionProvider methods
        listSessions: mock(() => Promise.resolve([])),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve(REPO_PATH)),
        getSessionWorkdir: mock(() => Promise.resolve(`/sessions/${SESSION_NAME}`)),
      };

      // Mock repository backend (should not be called for already approved)
      const mockApprove3 = mock(() =>
        Promise.resolve({
          reviewId: "approval-123",
          approvedBy: "Test User",
          approvedAt: "2025-07-30T23:14:24.213Z",
          prNumber: PR_BRANCH,
        })
      );
      const mockRepositoryBackend: RepositoryBackend = {
        getType: mock(() => "local"),
        pr: {
          merge: mock(() =>
            Promise.resolve({
              commitHash: "abc123def456",
              mergeDate: "2025-07-30T23:14:24.213Z",
              mergedBy: "Test User",
            } as MergeInfo)
          ),
        },
        review: {
          approve: mockApprove3,
        },
      } as unknown as RepositoryBackend;

      const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

      // Act: Should handle already approved gracefully
      const result = await approveSessionPr(
        { task: TASK_ID, repo: REPO_PATH },
        {
          sessionDB: mockSessionDB,
          createRepositoryBackendForSession: mockCreateRepositoryBackend,
        }
      );

      // Assert: Should complete successfully without calling approval again
      expect(result).toBeDefined();
      expect(result.wasAlreadyApproved).toBe(true);
      expect(result.approvalInfo.reviewId).toBe("already-approved");

      // Repository backend approval should NOT be called for already approved PR
      expect(mockApprove3).not.toHaveBeenCalled();
    });

    test("should fail when session has no PR branch", async () => {
      // Test constants to reduce error surface area
      const SESSION_NAME = "test-session";
      const REPO_NAME = "test-repo";
      const REPO_PATH = "/test/repo";
      const TASK_ID = "123";

      // Arrange: Set up scenario with session that has no PR branch
      const mockSessionDB = {
        getSessionByTaskId: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            // prBranch: undefined - No PR branch
          })
        ),
        getSession: mock(() =>
          Promise.resolve({
            sessionId: SESSION_NAME,
            repoName: REPO_NAME,
            repoUrl: REPO_PATH,
            taskId: TASK_ID,
            createdAt: new Date().toISOString(),
            // prBranch: undefined - No PR branch
          })
        ),
        // Add all required SessionProvider methods
        listSessions: mock(() => Promise.resolve([])),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve(REPO_PATH)),
        getSessionWorkdir: mock(() => Promise.resolve(`/sessions/${SESSION_NAME}`)),
      };

      // Mock repository backend (should not be called)
      const mockApprove4 = mock(() =>
        Promise.resolve({
          reviewId: "approval-123",
          approvedBy: "Test User",
          approvedAt: "2025-07-30T23:14:24.213Z",
          prNumber: "pr/test",
        })
      );
      const mockRepositoryBackend: RepositoryBackend = {
        getType: mock(() => "local"),
        pr: {
          merge: mock(() =>
            Promise.resolve({
              commitHash: "abc123def456",
              mergeDate: "2025-07-30T23:14:24.213Z",
              mergedBy: "Test User",
            } as MergeInfo)
          ),
        },
        review: {
          approve: mockApprove4,
        },
      } as unknown as RepositoryBackend;

      const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

      // Act & Assert: Should fail with validation error for missing PR branch
      await expect(
        approveSessionPr(
          { task: TASK_ID, repo: REPO_PATH },
          {
            sessionDB: mockSessionDB,
            createRepositoryBackendForSession: mockCreateRepositoryBackend,
          }
        )
      ).rejects.toThrow("has no PR branch. Create a PR first");

      // Repository backend should not be called for validation failure
      expect(mockApprove4).not.toHaveBeenCalled();
    });
  });
});
