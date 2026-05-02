import { test, expect, describe, mock, beforeEach } from "bun:test";
import { ConflictDetectionService, type ConflictDetectionDeps } from "./conflict-detection";
import { ConflictType } from "./conflict-detection-types";

type ExecAsyncFn = ConflictDetectionDeps["execAsync"];
type GitFetchFn = ConflictDetectionDeps["gitFetchWithTimeout"];

function createMockDeps(): ConflictDetectionDeps & {
  mockExecAsyncImpl: () => Promise<{ stdout: string; stderr: string }>;
  setExecAsyncImpl: (impl: () => Promise<{ stdout: string; stderr: string }>) => void;
} {
  let execAsyncImpl = () => Promise.resolve({ stdout: "", stderr: "" });
  const mockExecAsync = mock((...args: unknown[]) => execAsyncImpl());
  const mockGitFetchWithTimeout = mock(() => Promise.resolve({ stdout: "", stderr: "" }));

  return {
    execAsync: mockExecAsync as unknown as ExecAsyncFn,
    gitFetchWithTimeout: mockGitFetchWithTimeout as unknown as GitFetchFn,
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

  describe("mergeWithConflictPrevention — conflict status code coverage (mt#1367)", () => {
    /**
     * Helper that builds a ConflictDetectionService with injected deps where:
     * - the first execAsync call (rev-parse HEAD before merge) returns a hash
     * - the second execAsync call (the merge itself) throws to simulate a conflict
     * - the third execAsync call (git status --porcelain after merge fails) returns statusOutput
     */
    function makeServiceWithStatusOutput(statusOutput: string): ConflictDetectionService {
      let callIndex = 0;
      const mockExecAsync = mock((_cmd: string) => {
        callIndex++;
        if (callIndex === 1) {
          // git rev-parse HEAD (before merge)
          return Promise.resolve({ stdout: "before-hash", stderr: "" });
        }
        if (callIndex === 2) {
          // git merge <branch> — simulate conflict by throwing
          return Promise.reject(new Error("merge failed: conflicts"));
        }
        if (callIndex === 3) {
          // git status --porcelain
          return Promise.resolve({ stdout: statusOutput, stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const mockDeps: ConflictDetectionDeps = {
        execAsync: mockExecAsync as unknown as ExecAsyncFn,
        gitFetchWithTimeout: mock(() =>
          Promise.resolve({ stdout: "", stderr: "" })
        ) as unknown as GitFetchFn,
        log: { debug: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
      };

      return new ConflictDetectionService(mockDeps);
    }

    test("AU status code surfaces as hasConflicts=true with correct file path", async () => {
      const service = makeServiceWithStatusOutput("AU src/added-by-us.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/added-by-us.ts");
    });

    test("UA status code surfaces as hasConflicts=true with correct file path", async () => {
      const service = makeServiceWithStatusOutput("UA src/added-by-them.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/added-by-them.ts");
    });

    test("DU status code surfaces as hasConflicts=true with correct file path", async () => {
      const service = makeServiceWithStatusOutput("DU src/deleted-by-us.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/deleted-by-us.ts");
    });

    test("UD status code surfaces as hasConflicts=true with correct file path", async () => {
      const service = makeServiceWithStatusOutput("UD src/deleted-by-them.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/deleted-by-them.ts");
    });

    test("UU status code continues to surface as hasConflicts=true", async () => {
      const service = makeServiceWithStatusOutput("UU src/both-modified.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/both-modified.ts");
    });

    test("mixed AU and UU status codes all appear in conflictedFiles", async () => {
      const service = makeServiceWithStatusOutput(
        "UU src/content.ts\nAU src/added.ts\nUA src/theirs.ts\n"
      );
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/content.ts");
      expect(result.conflictedFiles).toContain("src/added.ts");
      expect(result.conflictedFiles).toContain("src/theirs.ts");
      expect(result.conflictedFiles).toHaveLength(3);
    });

    test("path with spaces has surrounding quotes stripped", async () => {
      const service = makeServiceWithStatusOutput('UU "src/path with spaces.ts"\n');
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/path with spaces.ts");
    });

    test("rename status uses destination path, not old -> new literal", async () => {
      const service = makeServiceWithStatusOutput("UU src/old-name.ts -> src/new-name.ts\n");
      const result = await service.mergeWithConflictPrevention(
        testRepoPath,
        "origin/main",
        sessionBranch,
        { skipConflictCheck: true }
      );

      expect(result.conflicts).toBe(true);
      expect(result.conflictedFiles).toContain("src/new-name.ts");
      // The old path must NOT appear in the list
      expect(result.conflictedFiles).not.toContain("src/old-name.ts");
    });
  });

  describe("smartSessionUpdate (mt#990 regression)", () => {
    const CALL_EXEC_ASYNC = "execAsync";
    const CALL_GIT_FETCH = "gitFetchWithTimeout";

    test("fetches base branch before analyzing divergence", async () => {
      // Regression for mt#990: without an explicit fetch before divergence analysis,
      // a stale local origin/<baseBranch> ref causes smartSessionUpdate to silently
      // no-op even when the remote has new commits. The fix: fetch first, then analyze.

      // Record call order by tagging both mocks.
      const callOrder: string[] = [];
      const mockExecAsync = mock(() => {
        callOrder.push(CALL_EXEC_ASYNC);
        return Promise.resolve({ stdout: "0\t0", stderr: "" });
      });
      const mockGitFetchWithTimeout = mock(() => {
        callOrder.push(CALL_GIT_FETCH);
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const instrumentedDeps: ConflictDetectionDeps = {
        execAsync: mockExecAsync as unknown as ExecAsyncFn,
        gitFetchWithTimeout: mockGitFetchWithTimeout as unknown as GitFetchFn,
        log: { debug: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
      };

      await ConflictDetectionService.smartSessionUpdate(
        testRepoPath,
        sessionBranch,
        baseBranch,
        undefined,
        instrumentedDeps
      );

      // Fetch must happen, and it must happen before any execAsync call that
      // reads tracking refs (rev-list / merge-base / etc. during divergence analysis).
      expect(mockGitFetchWithTimeout).toHaveBeenCalled();
      const firstFetchIdx = callOrder.indexOf(CALL_GIT_FETCH);
      const firstExecIdx = callOrder.indexOf(CALL_EXEC_ASYNC);
      expect(firstFetchIdx).toBeGreaterThanOrEqual(0);
      if (firstExecIdx >= 0) {
        expect(firstFetchIdx).toBeLessThan(firstExecIdx);
      }
    });

    test("fetch is invoked with correct remote and base branch", async () => {
      const mockGitFetchWithTimeout = mock(() => Promise.resolve({ stdout: "", stderr: "" }));
      const instrumentedDeps: ConflictDetectionDeps = {
        execAsync: mock(() =>
          Promise.resolve({ stdout: "0\t0", stderr: "" })
        ) as unknown as ExecAsyncFn,
        gitFetchWithTimeout: mockGitFetchWithTimeout as unknown as GitFetchFn,
        log: { debug: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
      };

      await ConflictDetectionService.smartSessionUpdate(
        testRepoPath,
        sessionBranch,
        baseBranch,
        undefined,
        instrumentedDeps
      );

      expect(mockGitFetchWithTimeout).toHaveBeenCalledWith("origin", baseBranch, {
        workdir: testRepoPath,
      });
    });
  });
});
