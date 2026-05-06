import { describe, test, expect } from "bun:test";
import {
  formatBlockMessage,
  checkBranchFreshness,
  refreshRemoteRefs,
  applyHostCap,
  getCurrentBudgets,
  type BranchFreshnessResult,
} from "./check-branch-fresh";
import {
  readHostCap,
  findHostCapInSettings,
  deriveBudgets,
  OVERALL_BUDGET_RATIO,
  FETCH_TIMEOUT_RATIO,
  GIT_TIMEOUT_RATIO,
  MIN_DERIVED_BUDGET_MS,
  DEFAULT_HOST_CAP_SEC,
} from "./types";

// Shared fixtures for mt#1546 tests — extracted to avoid magic-string
// duplication warnings.
const HOOK_FILENAME = "check-branch-fresh.ts";
const SESSION_COMMIT_MATCHER = "mcp__minsky__session_commit";
const HOOK_COMMAND_PATH = `$CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_FILENAME}`;
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";
const FAKE_PROJECT_DIR = "/fake/project/root";
const NO_MATCHER_FOUND_FRAGMENT = "No matcher entry found";

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

  test("derives branch name from mainRef in guidance (origin/master → master)", () => {
    const msg = formatBlockMessage("feature/my-branch", "origin/master", 1, [
      FIXTURE_COMMIT_SINGLE,
    ]);

    // Round-2 BLOCKING fix: guidance must use the detected default branch name,
    // not hardcoded "main". For origin/master the message should say "master".
    expect(msg).toContain("Review the new commits on master before continuing");
    expect(msg).toContain("rebase this branch on current master");
    expect(msg).not.toContain("Review the new commits on main");
    expect(msg).not.toContain("rebase this branch on current main.");
  });

  test("derives branch name from mainRef in guidance (origin/main → main)", () => {
    const msg = formatBlockMessage("task/mt-1483", "origin/main", 1, [FIXTURE_COMMIT_SINGLE]);

    expect(msg).toContain("Review the new commits on main before continuing");
    expect(msg).toContain("rebase this branch on current main.");
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
      silent: true,
      currentBranch: branch,
    };
  }

  const mainRef = deps.detectDefaultRemoteBranch(repoDir);
  if (!mainRef) {
    return {
      blocked: false,
      aheadCount: 0,
      aheadSubjects: [],
      reason: "Could not detect origin/main or origin/master — freshness check skipped",
      silent: true,
      currentBranch: branch,
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
      mainRef,
      silent: true,
      currentBranch: branch,
    };
  }

  return {
    blocked: true,
    aheadCount: count,
    aheadSubjects: subjects,
    reason: `${mainRef} is ${count} commit(s) ahead of origin/${branch}`,
    mainRef,
    currentBranch: branch,
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

  describe("mainRef pass-through (round-2 BLOCKING #2 fix)", () => {
    test("includes mainRef on blocked result so denial message uses the same ref the comparison used", () => {
      const deps = makeDeps({
        detectDefaultRemoteBranch: () => "origin/master",
        listCommitsAhead: () => ({ count: 2, subjects: ["a feat", "b fix"] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(true);
      expect(result.mainRef).toBe("origin/master");
    });

    test("includes mainRef on up-to-date result", () => {
      const deps = makeDeps({
        detectDefaultRemoteBranch: () => "origin/main",
        listCommitsAhead: () => ({ count: 0, subjects: [] }),
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.mainRef).toBe("origin/main");
    });

    test("omits mainRef on fresh-branch result (no comparison ran)", () => {
      const deps = makeDeps({
        remoteBranchExists: () => false,
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.mainRef).toBeUndefined();
    });

    test("omits mainRef on undetectable-default result", () => {
      const deps = makeDeps({
        detectDefaultRemoteBranch: () => null,
      });

      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.mainRef).toBeUndefined();
    });
  });

  describe("silent flag (round-3 BLOCKING #2 fix)", () => {
    test("fresh-branch result is marked silent", () => {
      const deps = makeDeps({ remoteBranchExists: () => false });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.silent).toBe(true);
    });

    test("up-to-date result is marked silent", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 0, subjects: [] }),
      });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.silent).toBe(true);
    });

    test("blocked result is NOT marked silent (deny message must reach the agent)", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 1, subjects: ["abc1234 fix"] }),
      });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(true);
      expect(result.silent).not.toBe(true);
    });

    test("undetectable-default result IS marked silent (round-4 BLOCKING fix — Behavioral Contract lists this path as silent)", () => {
      const deps = makeDeps({ detectDefaultRemoteBranch: () => null });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(false);
      expect(result.silent).toBe(true);
    });
  });

  describe("currentBranch pass-through (round-5 BLOCKING #2 fix)", () => {
    test("blocked result includes currentBranch so the entrypoint avoids re-detection outside the budget guard", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 2, subjects: ["a feat", "b fix"] }),
      });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.blocked).toBe(true);
      expect(result.currentBranch).toBe(FEATURE_BRANCH);
    });

    test("up-to-date result includes currentBranch", () => {
      const deps = makeDeps({
        listCommitsAhead: () => ({ count: 0, subjects: [] }),
      });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.currentBranch).toBe(FEATURE_BRANCH);
    });

    test("fresh-branch result includes currentBranch", () => {
      const deps = makeDeps({ remoteBranchExists: () => false });
      const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

      expect(result.currentBranch).toBe(FEATURE_BRANCH);
    });
  });
});

// ---------------------------------------------------------------------------
// checkBranchFreshness (exported function) — detached HEAD edge case
// ---------------------------------------------------------------------------

describe("checkBranchFreshness (exported)", () => {
  test("allows when branch is null (detached HEAD) and marks the result silent (round-4 BLOCKING fix)", () => {
    // null branch simulates what detectCurrentBranch returns for detached HEAD.
    // Per the Behavioral Contract, detached HEAD is one of the four silent
    // paths — round-4 review caught that the result was missing silent: true.
    const result = checkBranchFreshness("/nonexistent/repo", null);

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("skipped");
    expect(result.silent).toBe(true);
  });

  test("budget guard: skips remaining work when hookStart deadline is already past", () => {
    // Round-2 BLOCKING #1 fix: pass hookStart from the entrypoint so the
    // cumulative wall-clock budget is enforced. Simulate a past deadline
    // by passing a hookStart timestamp at epoch — far past the 10s budget,
    // deterministic, and free of any real-time / fs coupling.
    //
    // The branch arg is a non-null string so the early "detached HEAD" guard
    // does not fire; the budget guard at the next step is what we're testing.
    //
    // Budget-exhausted is NOT a contract-silent path, so silent should not
    // be true here (operators should learn about hook timeouts).
    const epochTimestamp = 1;
    const result = checkBranchFreshness(MOCK_REPO, "test-branch", epochTimestamp);

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("skipped");
    expect(result.reason.toLowerCase()).toContain("budget");
    expect(result.silent).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral Contract amendment: warnings emit on silent paths (round-4)
// ---------------------------------------------------------------------------

describe("Behavioral Contract: warnings emit even on silent paths", () => {
  // The contract was amended in R4: silent means "nothing to report" for the
  // result's reason, but warnings (e.g., fetch failures) ALWAYS surface so
  // operators know when staleness is at play. This is documented in the hook
  // header comment and in .minsky/rules/hook-files.mdc.
  //
  // These tests pin the contract by exercising the runFreshnessCheck helper
  // and asserting the result-level structure. The entrypoint-level emission
  // (stdout + additionalContext) is verified by reading the entrypoint code,
  // which separately concatenates result.reason (gated by silent) and
  // warnings (always concatenated when non-empty).
  test("silent up-to-date result has no reason content that should leak", () => {
    const deps = makeDeps({
      listCommitsAhead: () => ({ count: 0, subjects: [] }),
    });
    const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

    // Result is silent — its reason should NOT be emitted by the entrypoint.
    expect(result.silent).toBe(true);
    // The reason itself is still informative; the gating is structural at
    // the entrypoint, not by reason content.
    expect(result.reason).toContain("up to date");
  });

  test("silent fresh-branch result has no reason content that should leak", () => {
    const deps = makeDeps({ remoteBranchExists: () => false });
    const result = runFreshnessCheck(MOCK_REPO, FEATURE_BRANCH, deps);

    expect(result.silent).toBe(true);
    expect(result.reason).toContain("does not exist yet");
  });
});

// ---------------------------------------------------------------------------
// refreshRemoteRefs — basic shape assertion
// ---------------------------------------------------------------------------

describe("refreshRemoteRefs", () => {
  test("returns {ok: false, reason} on non-existent repo (fail-open contract)", () => {
    // Round-2 BLOCKING #1 fix: hook must fetch before comparing refs. The
    // function must shape its failure as `{ok: false, reason}` so callers
    // can warn but continue rather than aborting the entire hook.
    const result = refreshRemoteRefs("/nonexistent/repo/does/not/exist");

    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Budget derivation from host cap (mt#1546)
// ---------------------------------------------------------------------------

describe("deriveBudgets (mt#1546)", () => {
  test("ratio constants are explicit and non-magic", () => {
    // Pin the design choices so any future tweak surfaces in the test diff.
    expect(OVERALL_BUDGET_RATIO).toBe(0.6);
    expect(FETCH_TIMEOUT_RATIO).toBe(0.55);
    expect(GIT_TIMEOUT_RATIO).toBe(0.17);
  });

  test("hostCapSec=15 produces values within ±10% of legacy hardcoded constants", () => {
    // Regression criterion from the spec: existing 29 hook tests must pass
    // with the default 15s cap, i.e., derived values must match the legacy
    // hardcoded values (1500, 5000, 9000) to within ±10%.
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(15);
    expect(overallBudgetMs).toBe(9000); // legacy: 9000 (exact)
    expect(fetchTimeoutMs).toBe(4950); // legacy: 5000 (-1%)
    expect(gitTimeoutMs).toBe(1530); // legacy: 1500 (+2%)
  });

  test("hostCapSec=30 doubles overall budget and scales fetch/git proportionally", () => {
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(30);
    expect(overallBudgetMs).toBe(18000);
    expect(fetchTimeoutMs).toBe(9900);
    expect(gitTimeoutMs).toBe(3060);
  });

  test("hostCapSec=10 scales budget down proportionally", () => {
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(10);
    expect(overallBudgetMs).toBe(6000);
    expect(fetchTimeoutMs).toBe(3300);
    expect(gitTimeoutMs).toBe(1020);
  });

  test("hostCapSec=5 scales budget down proportionally", () => {
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(5);
    expect(overallBudgetMs).toBe(3000);
    expect(fetchTimeoutMs).toBe(1650);
    expect(gitTimeoutMs).toBe(510);
  });

  test("derived values are integers (Math.floor applied to non-integer products)", () => {
    // hostCap=7 → overall = floor(7000 * 0.6) = 4200
    //         → fetch   = floor(4200 * 0.55) = 2310
    //         → git     = floor(4200 * 0.17) = 714
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(7);
    expect(overallBudgetMs).toBe(4200);
    expect(fetchTimeoutMs).toBe(2310);
    expect(gitTimeoutMs).toBe(714);
    expect(Number.isInteger(overallBudgetMs)).toBe(true);
    expect(Number.isInteger(fetchTimeoutMs)).toBe(true);
    expect(Number.isInteger(gitTimeoutMs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readHostCap settings.json reader (mt#1546)
// ---------------------------------------------------------------------------

describe("readHostCap (mt#1546)", () => {
  // Tests inject a fake `readFile` adapter so no real filesystem operations
  // run. Settings.json content is hand-built per test.

  function settingsWithHook(timeout: unknown): string {
    return JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: HOOK_COMMAND_PATH,
                ...(timeout !== undefined ? { timeout } : {}),
                statusMessage: "Checking...",
              },
            ],
          },
        ],
      },
    });
  }

  test("returns the matcher entry's timeout when settings.json is well-formed", () => {
    const fakeRead = (_: string) => settingsWithHook(30);
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(30);
    expect(info.source).toBe("settings.json");
    expect(info.warning).toBeUndefined();
  });

  test("falls back to default + warning when settings.json cannot be read", () => {
    const fakeRead = (_: string) => {
      throw new Error("ENOENT: no such file or directory");
    };
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain("Could not read");
  });

  test("falls back to default + warning when settings.json is malformed JSON", () => {
    const fakeRead = (_: string) => "{ this is not valid json";
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain("Could not parse");
  });

  test("falls back to default + warning when no matcher entry references the hook", () => {
    const otherHookSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "mcp__minsky__session_pr_merge",
            hooks: [
              {
                type: "command",
                command: "$CLAUDE_PROJECT_DIR/.claude/hooks/some-other-hook.ts",
                timeout: 99,
              },
            ],
          },
        ],
      },
    });
    const fakeRead = (_: string) => otherHookSettings;
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain(NO_MATCHER_FOUND_FRAGMENT);
  });

  test("falls back to default + warning when matched entry has missing timeout", () => {
    const fakeRead = (_: string) => settingsWithHook(undefined);
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain("missing/invalid timeout");
  });

  test("falls back to default + warning when matched entry has invalid (non-positive) timeout", () => {
    const fakeRead = (_: string) => settingsWithHook(0);
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain("missing/invalid timeout");
  });

  test("falls back to default + warning when projectDir undefined and CLAUDE_PROJECT_DIR unset", () => {
    const original = process.env[PROJECT_DIR_ENV];
    delete process.env[PROJECT_DIR_ENV];
    try {
      const info = readHostCap(HOOK_FILENAME);
      expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
      expect(info.source).toBe("default");
      expect(info.warning).toContain(PROJECT_DIR_ENV);
      expect(info.warning).toContain("not set");
    } finally {
      if (original !== undefined) {
        process.env[PROJECT_DIR_ENV] = original;
      }
    }
  });

  test("walks multiple matcher entries and finds the right one by exact-or-suffix match", () => {
    const multiMatcherSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "/path/to/other-hook.ts", timeout: 5 }],
          },
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              { type: "command", command: "/path/to/parallel-work-guard.ts", timeout: 10 },
              {
                type: "command",
                command: HOOK_COMMAND_PATH,
                timeout: 20,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "/path/to/audit.ts", timeout: 5 }],
          },
        ],
      },
    });
    const fakeRead = (_: string) => multiMatcherSettings;
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(20);
    expect(info.source).toBe("settings.json");
  });

  test("findHostCapInSettings walker is exported and usable directly with a parsed-content string", () => {
    // Pure-function direct usage path — exercised by the same walker as
    // readHostCap, but without the file-reader layer. This exists so future
    // hooks can reuse just the walker if they read settings.json themselves.
    const info = findHostCapInSettings(settingsWithHook(45), HOOK_FILENAME);
    expect(info.hostCapSec).toBe(45);
    expect(info.source).toBe("settings.json");
  });

  // PR #958 R1 BLOCKING #1: tighten loose substring match.
  test("does NOT match a longer command whose suffix contains the hook filename inside another segment", () => {
    // Pre-fix: `.includes("check-branch-fresh.ts")` would substring-match
    // `.../check-branch-fresh.ts.bak`. Post-fix: only exact equality OR
    // `*/<basename>` suffix matches.
    const trapSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${HOOK_COMMAND_PATH}.bak`,
                timeout: 99,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(trapSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain(NO_MATCHER_FOUND_FRAGMENT);
  });

  test("rejects bare-substring collisions (`fresh.ts` does not match `check-branch-fresh.ts`)", () => {
    // `"fresh.ts"` is a substring of `"check-branch-fresh.ts"` BUT not a
    // path-segment suffix — the segment is `check-branch-fresh.ts`, not
    // `fresh.ts`. Suffix match correctly rejects.
    const collisionSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 20 }],
          },
        ],
      },
    });
    const info = findHostCapInSettings(collisionSettings, "fresh.ts");
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
  });

  test("matches an exact-equality command (no path prefix)", () => {
    // Pure-basename `command` (no `$CLAUDE_PROJECT_DIR/.claude/hooks/`
    // prefix) — exact equality must match.
    const bareSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [{ type: "command", command: HOOK_FILENAME, timeout: 25 }],
          },
        ],
      },
    });
    const info = findHostCapInSettings(bareSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(25);
    expect(info.source).toBe("settings.json");
  });

  test("events filter restricts walk to specified events (PR #958 R1 BLOCKING #1)", () => {
    // Same hook wired into both PreToolUse and PostToolUse with different
    // timeouts. The events filter should pin the lookup to PreToolUse.
    const dualWiredSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 15 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 99 }],
          },
        ],
      },
    });
    const info = findHostCapInSettings(dualWiredSettings, HOOK_FILENAME, {
      events: ["PreToolUse"],
    });
    expect(info.hostCapSec).toBe(15);
    expect(info.source).toBe("settings.json");
  });

  // PR #958 R2 BLOCKING #1: cross-platform path-separator normalisation.
  test("matches a Windows-style backslash command (PR #958 R2 BLOCKING #1)", () => {
    const winSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `C:\\repo\\.claude\\hooks\\${HOOK_FILENAME}`,
                timeout: 18,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(winSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(18);
    expect(info.source).toBe("settings.json");
  });

  // PR #958 R2 NON-BLOCKING #3: readHostCap defaults events to ["PreToolUse"].
  test("readHostCap defaults events filter to ['PreToolUse'] (PR #958 R2 NON-BLOCKING #3)", () => {
    // PostToolUse entry (timeout 99) MUST NOT be matched by default; the
    // PreToolUse entry (timeout 22) wins.
    const dualWiredSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 22 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 99 }],
          },
        ],
      },
    });
    const fakeRead = (_: string) => dualWiredSettings;
    // No explicit events filter → default ["PreToolUse"] kicks in.
    const info = readHostCap(HOOK_FILENAME, FAKE_PROJECT_DIR, { readFile: fakeRead });
    expect(info.hostCapSec).toBe(22);
    expect(info.source).toBe("settings.json");
  });

  // PR #958 R3 BLOCKING #1: matcher must handle commands with arguments.
  test("matches a command with trailing arguments (PR #958 R3 BLOCKING #1)", () => {
    const argsSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${HOOK_COMMAND_PATH} --quiet --debug`,
                timeout: 17,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(argsSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(17);
    expect(info.source).toBe("settings.json");
  });

  test("matches a command wrapped in `bun run` with trailing args (PR #958 R3 BLOCKING #1)", () => {
    const wrapperSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `bun run ${HOOK_COMMAND_PATH} --flag value`,
                timeout: 19,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(wrapperSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(19);
  });

  test("matches a command wrapped in `node` (PR #958 R3 BLOCKING #1)", () => {
    const nodeSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `node /abs/path/to/${HOOK_FILENAME}`,
                timeout: 21,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(nodeSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(21);
  });

  // PR #958 R4 BLOCKING: matcher must handle quoted command tokens.
  test("matches a double-quoted hook path with trailing args (PR #958 R4 BLOCKING)", () => {
    const quotedSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `"${HOOK_COMMAND_PATH}" --quiet`,
                timeout: 27,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(quotedSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(27);
  });

  test("matches a single-quoted hook path (PR #958 R4 BLOCKING)", () => {
    const sQuoteSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `'${HOOK_COMMAND_PATH}'`,
                timeout: 29,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(sQuoteSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(29);
  });

  // PR #958 R5 BLOCKING: false-positive prevention.
  test("does NOT match when hook basename appears only as an argument value (PR #958 R5 BLOCKING)", () => {
    // The actual executable is `other-hook.ts`; the check-branch-fresh.ts
    // appears as an arg value. Pre-fix: tokenizer scanned all tokens and
    // would falsely match arg position. Post-fix: only first 3 tokens
    // checked, so arg-position matches are rejected.
    const trapSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `bun run other-hook.ts --input $CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_FILENAME}`,
                timeout: 99,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(trapSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
    expect(info.source).toBe("default");
    expect(info.warning).toContain(NO_MATCHER_FOUND_FRAGMENT);
  });

  test("rejects when an unknown wrapper precedes the basename (PR #958 R5/R6)", () => {
    // `some-unknown-wrapper` is not in KNOWN_WRAPPERS, so it IS the exec
    // token. The basename appearing later is an argument, not the script.
    const trapSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `some-unknown-wrapper --flag ${HOOK_FILENAME}`,
                timeout: 88,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(trapSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
  });

  // PR #958 R6 BLOCKING: env-prefixed commands.
  test("matches `FOO=1 BAR=2 bun run X` env-prefixed wrapper invocation (PR #958 R6 BLOCKING)", () => {
    const envPrefixedSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `FOO=1 BAR=2 bun run ${HOOK_COMMAND_PATH} --flag`,
                timeout: 41,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(envPrefixedSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(41);
  });

  test("matches `env FOO=1 node X` env-wrapper invocation (PR #958 R6 BLOCKING)", () => {
    const envWrapperSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `env FOO=1 node ${HOOK_COMMAND_PATH}`,
                timeout: 43,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(envWrapperSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(43);
  });

  test("matches `env FOO=1 BAR=2 bun run X` (env wrapper + env vars + bun-run) (PR #958 R6 BLOCKING)", () => {
    const composedSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `env FOO=1 BAR=2 bun run ${HOOK_COMMAND_PATH}`,
                timeout: 47,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(composedSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(47);
  });

  test("rejects when the env-prefix never reveals the hook script (false-positive regression)", () => {
    // After skipping FOO=1 and bun+run, the executable token is `other.ts`.
    // The basename appears as an argument value, not as the executable.
    // Must still NOT match.
    const trapSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `FOO=1 bun run other.ts --input $CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_FILENAME}`,
                timeout: 99,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(trapSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(DEFAULT_HOST_CAP_SEC);
  });

  // PR #958 R5 NON-BLOCKING #3: type discriminator validation.
  test("ignores hook entries whose `type` is not 'command' (PR #958 R5 NON-BLOCKING #3)", () => {
    // Hypothetical future schema with a non-command type that happens to
    // include a `command`-shaped field — must NOT match.
    const futureTypeSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "future-type",
                command: HOOK_COMMAND_PATH,
                timeout: 77,
              },
              {
                type: "command",
                command: HOOK_COMMAND_PATH,
                timeout: 33,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(futureTypeSettings, HOOK_FILENAME);
    // Should match the second entry (type === "command", timeout 33),
    // not the first (timeout 77).
    expect(info.hostCapSec).toBe(33);
  });

  test("matches `bun run` with quoted hook path + args (PR #958 R4 BLOCKING)", () => {
    const wrapperQuotedSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `bun run "${HOOK_COMMAND_PATH}" --flag`,
                timeout: 31,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(wrapperQuotedSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(31);
  });

  test("matches a Windows-path-with-args command (cross-platform regression)", () => {
    const winArgsSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [
              {
                type: "command",
                command: `C:\\repo\\.claude\\hooks\\${HOOK_FILENAME} --flag`,
                timeout: 23,
              },
            ],
          },
        ],
      },
    });
    const info = findHostCapInSettings(winArgsSettings, HOOK_FILENAME);
    expect(info.hostCapSec).toBe(23);
  });

  test("events: [] means no filter (scan all events)", () => {
    // When the caller explicitly opts out of the default filter via empty
    // array, the walker scans every event and returns the FIRST match in
    // iteration order. Object.entries preserves insertion order in modern
    // engines so this is deterministic per-shape.
    const dualWiredSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: SESSION_COMMIT_MATCHER,
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 22 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: HOOK_COMMAND_PATH, timeout: 99 }],
          },
        ],
      },
    });
    const info = findHostCapInSettings(dualWiredSettings, HOOK_FILENAME, { events: [] });
    expect(info.hostCapSec).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// Minimum-budget clamp (mt#1546 PR #958 R1 NON-BLOCKING #4)
// ---------------------------------------------------------------------------

describe("deriveBudgets minimum-budget clamp", () => {
  test("clamps git timeout to MIN_DERIVED_BUDGET_MS for pathologically small caps", () => {
    // Without the clamp, hostCapSec = 0.5 → overall = floor(500 * 0.6) = 300,
    //   git = floor(300 * 0.17) = 51, BELOW the 100ms minimum.
    // With the clamp: git = max(100, 51) = 100.
    const { gitTimeoutMs } = deriveBudgets(0.5);
    expect(gitTimeoutMs).toBe(MIN_DERIVED_BUDGET_MS);
  });

  test("clamps overall budget to MIN_DERIVED_BUDGET_MS at hostCapSec=0", () => {
    // hostCapSec = 0 would zero out everything without the clamp.
    const { overallBudgetMs, fetchTimeoutMs, gitTimeoutMs } = deriveBudgets(0);
    expect(overallBudgetMs).toBe(MIN_DERIVED_BUDGET_MS);
    expect(fetchTimeoutMs).toBe(MIN_DERIVED_BUDGET_MS);
    expect(gitTimeoutMs).toBe(MIN_DERIVED_BUDGET_MS);
  });

  test("clamp does NOT fire for realistic caps (>=5s)", () => {
    // Sanity: at 5s the smallest derived (git) should still be > MIN.
    const { gitTimeoutMs } = deriveBudgets(5);
    expect(gitTimeoutMs).toBeGreaterThan(MIN_DERIVED_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// applyHostCap entrypoint integration (mt#1546 PR #958 R1 BLOCKING #2)
// ---------------------------------------------------------------------------

describe("applyHostCap (mt#1546)", () => {
  // applyHostCap mutates module-level budgets, so each test restores the
  // default after running.
  function withDefaultBudgets(fn: () => void): void {
    try {
      fn();
    } finally {
      applyHostCap(DEFAULT_HOST_CAP_SEC);
    }
  }

  test("module-level budgets default to deriveBudgets(15) at import time (no fs/env coupling)", () => {
    const expected = deriveBudgets(DEFAULT_HOST_CAP_SEC);
    const actual = getCurrentBudgets();
    expect(actual.overallBudgetMs).toBe(expected.overallBudgetMs);
    expect(actual.fetchTimeoutMs).toBe(expected.fetchTimeoutMs);
    expect(actual.gitTimeoutMs).toBe(expected.gitTimeoutMs);
  });

  test("applyHostCap reassigns module-level budgets to the supplied cap", () => {
    withDefaultBudgets(() => {
      applyHostCap(30);
      const expected = deriveBudgets(30);
      const actual = getCurrentBudgets();
      expect(actual.overallBudgetMs).toBe(expected.overallBudgetMs);
      expect(actual.fetchTimeoutMs).toBe(expected.fetchTimeoutMs);
      expect(actual.gitTimeoutMs).toBe(expected.gitTimeoutMs);
    });
  });
});
