import { test, expect, describe, mock, beforeEach } from "bun:test";
import { ConflictDetectionService, type ConflictDetectionDeps } from "./conflict-detection";
import { ConflictType } from "./conflict-detection-types";

function createMockDeps(): ConflictDetectionDeps & {
  mockExecAsyncImpl: () => Promise<{ stdout: string; stderr: string }>;
  setExecAsyncImpl: (impl: () => Promise<{ stdout: string; stderr: string }>) => void;
} {
  let execAsyncImpl = () => Promise.resolve({ stdout: "", stderr: "" });
  const mockExecAsync = mock((...args: unknown[]) => execAsyncImpl());
  const mockGitFetchWithTimeout = mock(() => Promise.resolve({ stdout: "", stderr: "" }));

  return {
    execAsync: mockExecAsync as unknown as ConflictDetectionDeps["execAsync"],
    gitFetchWithTimeout:
      mockGitFetchWithTimeout as unknown as ConflictDetectionDeps["gitFetchWithTimeout"],
    log: {
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    mockExecAsyncImpl: () => execAsyncImpl(),
    setExecAsyncImpl: (impl: () => Promise<{ stdout: string; stderr: string }>) => {
      execAsyncImpl = impl;
    },
  };
}

describe("ConflictDetectionService", () => {
  const testRepoPath = "/test/repo";
  const sessionBranch = "session-branch";
  const baseBranch = "main";

  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe("analyzeBranchDivergence", () => {
    test("should detect when session is ahead of base", async () => {
      // Setup: session has 2 commits ahead, 0 behind
      let callCount = 0;
      deps.setExecAsyncImpl(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ stdout: "0\t2", stderr: "" }); // rev-list output: 0 behind, 2 ahead
        }
        if (callCount === 2) {
          return Promise.resolve({ stdout: "abc123", stderr: "" }); // merge-base output
        }
        if (callCount === 3) {
          return Promise.resolve({
            stdout: "commit1\ncommit2",
            stderr: "",
          }); // session commits
        }
        if (callCount === 4) {
          return Promise.resolve({ stdout: "tree-session", stderr: "" }); // session tree
        }
        if (callCount === 5) {
          return Promise.resolve({ stdout: "tree-base", stderr: "" }); // base tree (different)
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath,
        sessionBranch,
        baseBranch,
        deps
      );

      expect(result).toEqual({
        sessionBranch,
        baseBranch,
        aheadCommits: 2,
        behindCommits: 0,
        lastCommonCommit: "abc123",
        divergenceType: "ahead",
        sessionChangesInBase: false,
        recommendedAction: "none",
      });
    });

    test("should detect when session changes are already in base", async () => {
      // Setup: session changes are already merged to base
      let callCount = 0;
      deps.setExecAsyncImpl(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ stdout: "0\t1", stderr: "" }); // rev-list output: 0 behind, 1 ahead
        }
        if (callCount === 2) {
          return Promise.resolve({ stdout: "abc123", stderr: "" }); // merge-base output
        }
        if (callCount === 3) {
          return Promise.resolve({ stdout: "commit1", stderr: "" }); // session commits
        }
        if (callCount === 4) {
          return Promise.resolve({ stdout: "tree1", stderr: "" }); // session tree
        }
        if (callCount === 5) {
          return Promise.resolve({ stdout: "tree1", stderr: "" }); // base tree (same = changes already in base)
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath,
        sessionBranch,
        baseBranch,
        deps
      );

      expect(result.sessionChangesInBase).toBe(true);
      expect(result.recommendedAction).toBe("skip_update");
    });

    test("should detect when session is behind base", async () => {
      // Setup: session is 1 commit behind base
      let callCount = 0;
      deps.setExecAsyncImpl(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ stdout: "1\t0", stderr: "" }); // rev-list output: 1 behind, 0 ahead
        }
        if (callCount === 2) {
          return Promise.resolve({ stdout: "abc123", stderr: "" }); // merge-base output
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath,
        sessionBranch,
        baseBranch,
        deps
      );

      expect(result.divergenceType).toBe("behind");
      expect(result.recommendedAction).toBe("fast_forward");
    });

    test("should detect when branches have diverged", async () => {
      // Setup: branches have diverged (session has commits, base has different commits)
      let callCount = 0;
      deps.setExecAsyncImpl(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ stdout: "2\t3", stderr: "" }); // rev-list output: 2 behind, 3 ahead
        }
        if (callCount === 2) {
          return Promise.resolve({ stdout: "abc123", stderr: "" }); // merge-base output
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const result = await ConflictDetectionService.analyzeBranchDivergence(
        testRepoPath,
        sessionBranch,
        baseBranch,
        deps
      );

      expect(result.divergenceType).toBe("diverged");
      expect(result.recommendedAction).toBe("skip_update");
    });
  });

  describe("predictConflicts", () => {
    test("should return no conflicts when already merged", async () => {
      // Setup: already merged scenario
      let callCount = 0;
      deps.setExecAsyncImpl(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ stdout: "0\t1", stderr: "" }); // rev-list
        }
        if (callCount === 2) {
          return Promise.resolve({ stdout: "abc123", stderr: "" }); // merge-base
        }
        if (callCount === 3) {
          return Promise.resolve({ stdout: "commit1", stderr: "" }); // session commits
        }
        if (callCount === 4) {
          return Promise.resolve({ stdout: "tree1", stderr: "" }); // session tree
        }
        if (callCount === 5) {
          return Promise.resolve({ stdout: "tree1", stderr: "" }); // base tree (same)
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const result = await ConflictDetectionService.predictConflicts(
        testRepoPath,
        sessionBranch,
        baseBranch,
        deps
      );

      expect(result.hasConflicts).toBe(false);
      expect(result.conflictType).toBe(ConflictType.ALREADY_MERGED);
    });
  });
});
