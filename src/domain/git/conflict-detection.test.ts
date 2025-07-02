/**
 * Tests for ConflictDetectionService
 * 
 * Tests proactive conflict detection and resolution functionality
 * for improving merge conflict prevention in session PR workflow.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { 
  ConflictDetectionService, 
  ConflictType, 
  ConflictSeverity, 
  FileConflictStatus,
  type ConflictPrediction,
  type BranchDivergenceAnalysis
} from "./conflict-detection";

// Mock execAsync
const mockExecAsync = mock(() => Promise.resolve({ stdout: "", stderr: "" }));

// Mock logger
const mockLog = {
  debug: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {})
};

// Override the imports with mocks
mock.module("../../utils/exec", () => ({
  execAsync: mockExecAsync
}));

mock.module("../../utils/logger", () => ({
  log: mockLog
}));

describe("ConflictDetectionService", () => {
  const testRepoPath = "/test/repo";
  const sessionBranch = "session-branch";
  const baseBranch = "main";

  beforeEach(() => {
    mockExecAsync.mockClear();
    mockLog.debug.mockClear();
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
  });

  describe("analyzeBranchDivergence", () => {
    it("should detect when session is ahead of base", async () => {
      // Setup: session has 2 commits ahead, 0 behind
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "0\t2", stderr: "" }) // behind, ahead
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1\ncommit2", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }); // base tree

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result).toEqual({
        sessionBranch,
        baseBranch,
        aheadCommits: 2,
        behindCommits: 0,
        lastCommonCommit: "abc123",
        sessionChangesInBase: false,
        divergenceType: "ahead",
        recommendedAction: "none"
      });
    });

    it("should detect when session changes are already in base", async () => {
      // Setup: session has commits but trees are identical
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "0\t1", stderr: "" }) // behind, ahead
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }); // base tree (same)

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.sessionChangesInBase).toBe(true);
      expect(result.recommendedAction).toBe("skip_update");
    });

    it("should detect when session is behind base", async () => {
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "3\t0", stderr: "" }) // behind, ahead
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // no session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }); // base tree

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.divergenceType).toBe("behind");
      expect(result.recommendedAction).toBe("fast_forward");
    });

    it("should detect when branches have diverged", async () => {
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "2\t3", stderr: "" }) // behind, ahead
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1\ncommit2", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }); // base tree

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.divergenceType).toBe("diverged");
      expect(result.recommendedAction).toBe("update_needed");
    });
  });

  describe("predictConflicts", () => {
    it("should return no conflicts when already merged", async () => {
      // Setup: Complete call sequence for already-merged detection
      // The sequence is: analyzeBranchDivergence calls execAsync 3 times, then checkSessionChangesInBase calls execAsync 1 time (early return)
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "0\t1", stderr: "" }) // 1. rev-list --left-right --count
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 2. merge-base
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // 3. checkSessionChangesInBase: rev-list (empty = already merged)

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.hasConflicts).toBe(false);
      expect(result.conflictType).toBe(ConflictType.ALREADY_MERGED);
      expect(result.userGuidance).toContain("already been merged");
      expect(result.recoveryCommands).toContain("minsky session pr --no-update");
    });

    it("should detect delete/modify conflicts", async () => {
      // Setup: divergence analysis and simulate merge with delete conflicts
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // branch divergence
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // base tree
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout temp branch
        .mockRejectedValueOnce(new Error("CONFLICT: deleted in main, modified in session")) // merge fails
        .mockResolvedValueOnce({ stdout: "DU deleted-file.ts\nUD another-deleted.ts", stderr: "" }) // git status
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // abort merge
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // delete temp branch
        .mockResolvedValueOnce({ stdout: "abc456", stderr: "" }) // last commit for deleted file
        .mockResolvedValueOnce({ stdout: "def789", stderr: "" }); // last commit for another file

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.hasConflicts).toBe(true);
      expect(result.conflictType).toBe(ConflictType.DELETE_MODIFY);
      expect(result.severity).toBe(ConflictSeverity.AUTO_RESOLVABLE);
      expect(result.affectedFiles).toHaveLength(2);
      // DU = deleted by us, UD = deleted by them 
      expect(result.affectedFiles[0].status).toBe(FileConflictStatus.DELETED_BY_US);
      expect(result.affectedFiles[1].status).toBe(FileConflictStatus.DELETED_BY_THEM);
      expect(result.userGuidance).toContain("Deleted file conflicts detected");
      expect(result.recoveryCommands).toContain("git rm \"deleted-file.ts\"");
    });

    it("should detect content conflicts", async () => {
      // Setup: divergence analysis and simulate merge with content conflicts
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // branch divergence
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // base tree
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout temp branch
        .mockRejectedValueOnce(new Error("CONFLICT: Merge conflict in file.ts")) // merge fails
        .mockResolvedValueOnce({ stdout: "UU file.ts\nUU another.ts", stderr: "" }) // git status
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // abort merge
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // delete temp branch
        .mockResolvedValueOnce({ stdout: "line1\n<<<<<<< HEAD\nchanges\n=======\nother changes\n>>>>>>> main\nline3", stderr: "" }) // file content
        .mockResolvedValueOnce({ stdout: "line1\n<<<<<<< HEAD\nmore changes\n=======\nother changes\n>>>>>>> main\nline3", stderr: "" }); // another file content

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.hasConflicts).toBe(true);
      expect(result.conflictType).toBe(ConflictType.CONTENT_CONFLICT);
      expect(result.severity).toBe(ConflictSeverity.MANUAL_SIMPLE);
      expect(result.affectedFiles).toHaveLength(2);
      expect(result.affectedFiles[0].status).toBe(FileConflictStatus.MODIFIED_BOTH);
      expect(result.userGuidance).toContain("Content conflicts detected");
      expect(result.recoveryCommands).toContain("git status");
    });

    it("should return no conflicts when merge succeeds", async () => {
      // Setup: successful merge simulation
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // branch divergence
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // base tree
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // merge succeeds
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // reset
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // delete temp branch

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.hasConflicts).toBe(false);
      expect(result.conflictType).toBe(ConflictType.NONE);
      expect(result.severity).toBe(ConflictSeverity.NONE);
      expect(result.affectedFiles).toHaveLength(0);
      expect(result.userGuidance).toContain("No conflicts detected");
    });
  });

  describe("mergeWithConflictPrevention", () => {
    it("should perform dry run without actual merge", async () => {
      // Setup: Complete call sequence that detects conflicts during prediction
      mockExecAsync
        // analyzeBranchDivergence calls:
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // 1. rev-list --left-right --count
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 2. merge-base
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // 3. checkSessionChangesInBase: rev-list (not empty)
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // 4. session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // 5. base tree (different - not already merged)
        // simulateMerge calls:
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 6. create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 7. checkout temp branch
        .mockRejectedValueOnce(new Error("CONFLICT")) // 8. merge fails with conflicts
        .mockResolvedValueOnce({ stdout: "UU file.ts", stderr: "" }) // 9. git status shows conflicts
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 10. abort merge
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 11. checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 12. delete temp branch
        .mockResolvedValueOnce({ stdout: "conflict content", stderr: "" }); // 13. analyze conflict regions

      const result = await ConflictDetectionService.mergeWithConflictPrevention(
        testRepoPath, sessionBranch, baseBranch, { dryRun: true }
      );

      expect(result.merged).toBe(false);
      expect(result.conflicts).toBe(true);
      expect(result.prediction).toBeDefined();
      expect(result.prediction?.hasConflicts).toBe(true);
    });

    it("should perform actual merge when no conflicts predicted", async () => {
      // Setup: no conflicts, successful merge
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // branch divergence
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // base tree
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // merge succeeds
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // reset
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // delete temp branch
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // before hash
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // actual merge
        .mockResolvedValueOnce({ stdout: "def456", stderr: "" }); // after hash

      const result = await ConflictDetectionService.mergeWithConflictPrevention(
        testRepoPath, sessionBranch, baseBranch, { dryRun: false }
      );

      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
    });

    it("should auto-resolve delete conflicts when enabled", async () => {
      // Setup: Complete call sequence for delete conflicts with auto-resolution
      mockExecAsync
        // analyzeBranchDivergence calls:
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // 1. rev-list --left-right --count
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 2. merge-base
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // 3. checkSessionChangesInBase: rev-list (not empty)
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // 4. session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // 5. base tree (different)
        // simulateMerge calls:
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 6. create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 7. checkout temp branch
        .mockRejectedValueOnce(new Error("CONFLICT")) // 8. merge fails
        .mockResolvedValueOnce({ stdout: "DU deleted-file.ts", stderr: "" }) // 9. git status
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 10. abort merge
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 11. checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 12. delete temp branch
        .mockResolvedValueOnce({ stdout: "abc456", stderr: "" }) // 13. last commit for deleted file
        // autoResolveDeleteConflicts calls:
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 14. git rm for auto-resolution
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 15. commit resolution
        // actual merge calls:
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 16. before hash
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 17. actual merge
        .mockResolvedValueOnce({ stdout: "def456", stderr: "" }); // 18. after hash

      const result = await ConflictDetectionService.mergeWithConflictPrevention(
        testRepoPath, sessionBranch, baseBranch, { 
          autoResolveDeleteConflicts: true,
          dryRun: false 
        }
      );

      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
    });
  });

  describe("smartSessionUpdate", () => {
    it("should skip update when session changes already in base", async () => {
      // Setup: session changes already merged with skipIfAlreadyMerged option
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "0\t1", stderr: "" }) // 1. rev-list --left-right --count
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 2. merge-base
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // 3. checkSessionChangesInBase: rev-list (empty = already merged)

      const result = await ConflictDetectionService.smartSessionUpdate(
        testRepoPath, sessionBranch, baseBranch, { skipIfAlreadyMerged: true }
      );

      expect(result.updated).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("already in base branch");
      expect(result.divergenceAnalysis?.sessionChangesInBase).toBe(true);
    });

    it("should perform fast-forward when session is behind", async () => {
      // Setup: session is behind, not already merged
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "2\t0", stderr: "" }) // 1. behind=2, ahead=0
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // 2. merge-base
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // 3. session commits (not empty)
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // 4. session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // 5. base tree (different)
        // fast-forward update calls:
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // 6. fetch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // 7. fast-forward merge

      const result = await ConflictDetectionService.smartSessionUpdate(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.updated).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toContain("Fast-forward update completed");
    });

    it("should skip when session is ahead and no update needed", async () => {
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "0\t2", stderr: "" }) // branch divergence: behind=0, ahead=2
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1\ncommit2", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }); // base tree

      const result = await ConflictDetectionService.smartSessionUpdate(
        testRepoPath, sessionBranch, baseBranch
      );

      expect(result.updated).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("No update needed");
    });
  });

  describe("error handling", () => {
    it("should handle git command failures gracefully", async () => {
      mockExecAsync.mockRejectedValueOnce(new Error("Git command failed"));

      await expect(
        ConflictDetectionService.analyzeBranchDivergence(testRepoPath, sessionBranch, baseBranch)
      ).rejects.toThrow("Git command failed");

      expect(mockLog.error).toHaveBeenCalledWith(
        "Error analyzing branch divergence",
        expect.objectContaining({
          error: expect.any(Error),
          repoPath: testRepoPath,
          sessionBranch,
          baseBranch
        })
      );
    });

    it("should handle merge simulation cleanup failures gracefully", async () => {
      // Setup: successful merge simulation that fails during cleanup
      mockExecAsync
        .mockResolvedValueOnce({ stdout: "1\t1", stderr: "" }) // branch divergence
        .mockResolvedValueOnce({ stdout: "abc123", stderr: "" }) // common commit
        .mockResolvedValueOnce({ stdout: "commit1", stderr: "" }) // session commits
        .mockResolvedValueOnce({ stdout: "tree1", stderr: "" }) // session tree
        .mockResolvedValueOnce({ stdout: "tree2", stderr: "" }) // base tree
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // create temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout temp branch
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // merge succeeds
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // reset
        .mockResolvedValueOnce({ stdout: "", stderr: "" }) // checkout original
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // delete temp branch succeeds

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath, sessionBranch, baseBranch
      );

      // Should return successful result (no conflicts)
      expect(result.hasConflicts).toBe(false);
      expect(result.conflictType).toBe(ConflictType.NONE);
    });
  });
}); 
