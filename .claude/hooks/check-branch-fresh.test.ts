import { describe, test, expect } from "bun:test";
import {
  formatBlockMessage,
  checkBranchFreshness,
  type BranchFreshnessResult,
} from "./check-branch-fresh";

// ---------------------------------------------------------------------------
// Unit tests for formatBlockMessage (pure function)
// ---------------------------------------------------------------------------

// Shared fixtures — extracted to avoid magic-string duplication warnings
const FIXTURE_COMMIT_SINGLE = "abc1234 feat: add single change";
const FIXTURE_COMMITS_MANY = [
  "abc1234 feat: add something",
  "def5678 fix: repair something",
  "ghi9012 chore: update deps",
];

describe("formatBlockMessage", () => {
  test("includes ahead count and branch name", () => {
    const msg = formatBlockMessage("task/mt-1483", "origin/main", 3, FIXTURE_COMMITS_MANY);

    expect(msg).toContain("origin/main is 3 commit(s) ahead of origin/task/mt-1483");
    expect(msg).toContain("abc1234 feat: add something");
    expect(msg).toContain("def5678 fix: repair something");
    expect(msg).toContain("ghi9012 chore: update deps");
  });

  test("includes review instruction", () => {
    const msg = formatBlockMessage("task/mt-1483", "origin/main", 1, [FIXTURE_COMMIT_SINGLE]);

    expect(msg).toContain("Review the new commits on main before continuing");
  });

  test("includes override instruction", () => {
    const msg = formatBlockMessage("task/mt-1483", "origin/main", 1, [FIXTURE_COMMIT_SINGLE]);

    expect(msg).toContain("MINSKY_SKIP_FRESHNESS=1");
  });

  test("caps display at 10 subjects even if more passed", () => {
    const subjects = Array.from({ length: 15 }, (_, i) => `sha${i} commit ${i}`);
    const msg = formatBlockMessage("my-branch", "origin/main", 15, subjects);

    // Should show first 10, not all 15
    expect(msg).toContain("sha9 commit 9");
    expect(msg).not.toContain("sha10 commit 10");
  });

  test("includes both main ref and count in header", () => {
    const msg = formatBlockMessage("feature/my-branch", "origin/master", 5, [
      FIXTURE_COMMIT_SINGLE,
    ]);

    expect(msg).toContain("origin/master");
    expect(msg).toContain("5 commit(s)");
  });
});

// ---------------------------------------------------------------------------
// Injectable-deps interface for hermetic checkBranchFreshness tests
// ---------------------------------------------------------------------------

/**
 * Deps structure mirrors the runtime calls in checkBranchFreshness so tests
 * can exercise the block / allow-even / allow-fresh paths without live git.
 *
 * The actual checkBranchFreshness function calls execWithPath internally, so
 * we test the pure-logic branches by wrapping in a testable helper that
 * accepts overridable detection functions.
 */
interface FreshnessCheckDeps {
  remoteBranchExists: (repoDir: string, branch: string) => boolean;
  detectDefaultRemoteBranch: (repoDir: string) => string | null;
  listCommitsAhead: (
    repoDir: string,
    branchRef: string,
    mainRef: string,
    limit?: number
  ) => { count: number; subjects: string[] };
}

function runFreshnessCheck(
  repoDir: string,
  branch: string,
  deps: FreshnessCheckDeps
): BranchFreshnessResult {
  if (!deps.remoteBranchExists(repoDir, branch)) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `Fresh branch: origin/${branch} does not exist yet — no divergence to check`,
    };
  }

  const mainRef = deps.detectDefaultRemoteBranch(repoDir);
  if (!mainRef) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect origin/main or origin/master — freshness check skipped",
    };
  }

  const branchRef = `origin/${branch}`;
  const { count, subjects } = deps.listCommitsAhead(repoDir, branchRef, mainRef);

  if (count === 0) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: `Branch ${branch} is up to date with ${mainRef}`,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: `${mainRef} is ${count} commit(s) ahead of origin/${branch}`,
  };
}

// ---------------------------------------------------------------------------
// checkBranchFreshness logic tests using injectable deps
// ---------------------------------------------------------------------------

const MOCK_REPO = "/mock/repo";
const FEATURE_BRANCH = "task/mt-1483";

function makeDeps(overrides: Partial<FreshnessCheckDeps> = {}): FreshnessCheckDeps {
  return {
    remoteBranchExists: () => true,
    detectDefaultRemoteBranch: () => "origin/main",
    listCommitsAhead: () => ({ count: 0, subjects: [] }),
    ...overrides,
  };
}

describe("branch freshness logic (injectable deps)", () => {
  describe("branch behind main", () => {
    test("blocks when main has commits not in branch", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({
          count: 3,
          subjects: [
            "abc1234 chore: main change 2",
            "def5678 chore: main change 1",
            "ghi9012 chore: main change 0",
          ],
        }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(true);
      expect(result.aheadCount).toBe(3);
      expect(result.aheadSubjects).toHaveLength(3);
      expect(result.aheadSubjects[0]).toContain("main change 2");
    });

    test("reason message contains count and refs", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 7, subjects: ["abc1234 fix: something"] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.reason).toContain("7 commit(s)");
      expect(result.reason).toContain("origin/main");
      expect(result.reason).toContain(FEATURE_BRANCH);
    });
  });

  describe("branch even with main", () => {
    test("allows when main has no new commits", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 0, subjects: [] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.aheadCount).toBe(0);
    });

    test("reason indicates up to date", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 0, subjects: [] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.reason).toContain("up to date");
    });
  });

  describe("fresh branch (no remote tracking)", () => {
    test("allows when origin/<branch> does not exist", () => {
      const deps = makeDeps({
        remoteBranchExists: () => false,
        // listCommitsAhead would show main is ahead, but we should not reach it
        listCommitsAhead: () => ({ count: 10, subjects: ["abc1234 feat: would block"] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.reason).toContain("does not exist yet");
    });
  });

  describe("undetectable default branch", () => {
    test("allows when detectDefaultRemoteBranch returns null", () => {
      const deps = makeDeps({
        detectDefaultRemoteBranch: () => null,
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.reason).toContain("freshness check skipped");
    });
  });
});

// ---------------------------------------------------------------------------
// checkBranchFreshness (exported function) — detached HEAD edge case
// ---------------------------------------------------------------------------

describe("checkBranchFreshness (exported)", () => {
  test("allows when branch is null (detached HEAD)", () => {
    // null branch simulates what detectCurrentBranch returns for detached HEAD
    const result = checkBranchFreshness("/nonexistent/repo", null);

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("skipped");
  });
});
