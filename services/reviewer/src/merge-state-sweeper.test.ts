/**
 * Unit tests for the merge-state sweeper (mt#1614, mt#1752, mt#2121).
 *
 * Verifies:
 *   - runMergeStateSweep returns sessionsScanned=N when N sessions are listed.
 *   - Sessions whose PRs are merged on GitHub (live state via Octokit, not
 *     stored session.pullRequest.state) trigger apply_post_merge_state_sync.
 *   - Sessions whose PRs are open on GitHub do NOT trigger sync, regardless
 *     of stored state — mt#1752.
 *   - Sessions without a pullRequest.number are skipped gracefully.
 *   - loadMergeStateSweeperConfig reads from env vars correctly.
 *   - startMergeStateSweeper returns null when disabled or domain services absent.
 *
 * Domain services are injected via fake SessionProviderInterface objects —
 * the MCP-over-HTTP infrastructure was retired in mt#2121 and replaced with
 * direct domain imports. fetch is no longer mocked. Octokit is passed as a
 * fake object directly to runMergeStateSweep.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runMergeStateSweep,
  loadMergeStateSweeperConfig,
  startMergeStateSweeper,
  type MergeStateSweeperConfig,
  type MergeStateSweeperDeps,
} from "./merge-state-sweeper";
import type { ReviewerConfig } from "./config";
import type { Octokit } from "@octokit/rest";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import { silenceConsoleLogs, captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "edobry";
const REPO = "minsky";
const GITHUB_TIMEOUT_MS = 30_000;
const ENV_SWEEPER_ENABLED = "MERGE_STATE_SWEEPER_ENABLED";
const ENV_SWEEPER_INTERVAL_MS = "MERGE_STATE_SWEEPER_INTERVAL_MS";
const ENV_SWEEPER_REPO_OWNER = "SWEEPER_REPO_OWNER";
const ENV_SWEEPER_REPO_NAME = "SWEEPER_REPO_NAME";
const ENV_GITHUB_TIMEOUT_MS = "MERGE_STATE_SWEEPER_GITHUB_TIMEOUT_MS";

const BASE_REVIEWER_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 3000,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Fake domain services
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake SessionProviderInterface for testing.
 * listSessions() returns the provided sessions array.
 * All other methods throw (not needed by the sweeper).
 */
function makeSessionProvider(sessions: SessionRecord[]): SessionProviderInterface {
  return {
    listSessions: async () => sessions,
    getSession: async () => {
      throw new Error("getSession: not implemented in fake");
    },
    getSessionByTaskId: async () => {
      throw new Error("getSessionByTaskId: not implemented in fake");
    },
    addSession: async () => {
      throw new Error("addSession: not implemented in fake");
    },
    updateSession: async () => {
      throw new Error("updateSession: not implemented in fake");
    },
    deleteSession: async () => {
      throw new Error("deleteSession: not implemented in fake");
    },
    getRepoPath: async () => {
      throw new Error("getRepoPath: not implemented in fake");
    },
    getSessionWorkdir: async () => {
      throw new Error("getSessionWorkdir: not implemented in fake");
    },
  } as unknown as SessionProviderInterface;
}

/**
 * Minimal fake TaskServiceInterface (not called by the sweeper directly;
 * passed through to applySyncFn deps).
 */
const fakeTaskService: TaskServiceInterface = {} as TaskServiceInterface;

/**
 * Build a MergeStateSweeperDeps with the given session list and an
 * optional spy for the sync calls.
 */
function makeDeps(
  sessions: SessionRecord[],
  syncSpy?: (params: {
    sessionId: string;
    mergeSha?: string;
    mergedAt?: string;
    trigger: string;
  }) => Promise<void>
): MergeStateSweeperDeps {
  return {
    sessionProvider: makeSessionProvider(sessions),
    taskService: fakeTaskService,
    applySyncFn: syncSpy ?? (async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal SessionRecord for PR_OPEN sessions
// ---------------------------------------------------------------------------

/**
 * Build a minimal SessionRecord with PR_OPEN status.
 * The sweeper only accesses: sessionId, taskId, status, pullRequest.number.
 */
function makePrOpenSession(opts: {
  sessionId: string;
  taskId?: string;
  prNumber?: number;
}): SessionRecord {
  return {
    sessionId: opts.sessionId,
    taskId: opts.taskId,
    status: "PR_OPEN" as SessionRecord["status"],
    ...(opts.prNumber !== undefined
      ? {
          pullRequest: {
            number: opts.prNumber,
            url: `https://github.com/${OWNER}/${REPO}/pull/${opts.prNumber}`,
            state: "open" as const,
            createdAt: "2026-05-01T00:00:00Z",
            headBranch: "task/mt-9999",
            baseBranch: "main",
            lastSynced: "2026-05-01T00:00:00Z",
          },
        }
      : {}),
  } as SessionRecord;
}

// ---------------------------------------------------------------------------
// Fake Octokit (mt#1752)
// ---------------------------------------------------------------------------

/**
 * Build a fake Octokit instance with a per-pr_number `pulls.get` responder.
 * The responder shape matches Octokit's `pulls.get` response: `{ data: PullRequest }`
 * where PullRequest has `merged`, `merged_at`, and `merge_commit_sha`.
 *
 * Pass `throwForPrNumber` to make a specific PR's lookup throw (simulates 4xx/5xx).
 */
function makeFakeOctokit(opts: {
  prResponses: Record<
    number,
    { merged: boolean; merged_at?: string | null; merge_commit_sha?: string | null }
  >;
  throwForPrNumber?: number;
  onCall?: (pr_number: number) => void;
}): Octokit {
  const fake = {
    rest: {
      pulls: {
        get: async (args: { owner: string; repo: string; pull_number: number }) => {
          opts.onCall?.(args.pull_number);
          if (opts.throwForPrNumber === args.pull_number) {
            throw new Error(`fake octokit: pulls.get failed for #${args.pull_number}`);
          }
          const data = opts.prResponses[args.pull_number];
          if (!data) {
            throw new Error(`fake octokit: no fixture for PR #${args.pull_number}`);
          }
          return { data };
        },
      },
    },
  };
  return fake as unknown as Octokit;
}

// ---------------------------------------------------------------------------
// Log silencer
// ---------------------------------------------------------------------------

// The sweeper emits structured log lines via the reviewer-local winston
// logger (routed to process.stdout). Per-test silencing keeps `bun test`
// output clean and isolates tests from each other when bun runs files in
// parallel.
let stdoutSilencer: { restore: () => void } | null = null;

beforeEach(() => {
  stdoutSilencer = silenceConsoleLogs();
});

afterEach(() => {
  if (stdoutSilencer) {
    stdoutSilencer.restore();
    stdoutSilencer = null;
  }
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — no sessions
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — no sessions", () => {
  it("returns sessionsScanned=0 when session list returns empty array", async () => {
    const octokit = makeFakeOctokit({ prResponses: {} });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, makeDeps([]), GITHUB_TIMEOUT_MS);

    expect(result.sessionsScanned).toBe(0);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — open PRs not synced
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — open PRs not synced", () => {
  it("skips a session whose PR is still open on GitHub", async () => {
    const sessions = [makePrOpenSession({ sessionId: "s1", taskId: "mt#100", prNumber: 10 })];

    const octokit = makeFakeOctokit({
      prResponses: { 10: { merged: false } },
    });
    const result = await runMergeStateSweep(
      octokit,
      OWNER,
      REPO,
      makeDeps(sessions),
      GITHUB_TIMEOUT_MS
    );

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });

  it("skips a session whose PR is closed but unmerged on GitHub (mt#1752: trust live state)", async () => {
    // Regression guard for mt#1752: even if some other source said the PR was merged,
    // if GitHub says `merged: false` (e.g., the PR was closed without merge), do nothing.
    const sessions = [makePrOpenSession({ sessionId: "s1b", taskId: "mt#100b", prNumber: 11 })];

    const octokit = makeFakeOctokit({
      prResponses: { 11: { merged: false, merged_at: null, merge_commit_sha: null } },
    });
    const result = await runMergeStateSweep(
      octokit,
      OWNER,
      REPO,
      makeDeps(sessions),
      GITHUB_TIMEOUT_MS
    );

    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — merged PR triggers sync
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — merged PR triggers sync", () => {
  it("detects a merged PR on GitHub and calls applyPostMergeStateSync", async () => {
    const sessions = [makePrOpenSession({ sessionId: "s2", taskId: "mt#200", prNumber: 20 })];

    const syncCalledFor: { sessionId: string; mergeSha?: string; mergedAt?: string }[] = [];
    const deps = makeDeps(sessions, async (params) => {
      syncCalledFor.push({
        sessionId: params.sessionId,
        mergeSha: params.mergeSha,
        mergedAt: params.mergedAt,
      });
    });

    const octokit = makeFakeOctokit({
      prResponses: {
        20: {
          merged: true,
          merged_at: "2026-05-06T10:00:00.000Z",
          merge_commit_sha: "deadbeef",
        },
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, deps, GITHUB_TIMEOUT_MS);

    expect(result.sessionsScanned).toBe(1);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(syncCalledFor).toEqual([
      {
        sessionId: "s2",
        mergeSha: "deadbeef",
        mergedAt: "2026-05-06T10:00:00.000Z",
      },
    ]);
  });

  it("mt#1752 regression: detects merge from LIVE GitHub state even when stored state says open", async () => {
    // This is the central mt#1752 regression: the sweeper must detect merge via
    // Octokit's live `pulls.get`, NOT via the stored session.pullRequest.state.
    // Six historical drift incidents (mt#1772, mt#1773, mt#1774, mt#1777,
    // mt#1742, mt#1787) had session.pullRequest.state="open" stored despite
    // their PRs being merged on GitHub for hours.
    const sessions = [
      makePrOpenSession({ sessionId: "s_stale_open", taskId: "mt#1787", prNumber: 1083 }),
    ];

    let prGetCallCount = 0;
    const octokit = makeFakeOctokit({
      prResponses: {
        1083: {
          merged: true,
          merged_at: "2026-05-13T00:29:35Z",
          merge_commit_sha: "6c53e872c",
        },
      },
      onCall: () => {
        prGetCallCount++;
      },
    });
    const result = await runMergeStateSweep(
      octokit,
      OWNER,
      REPO,
      makeDeps(sessions),
      GITHUB_TIMEOUT_MS
    );

    // The sweeper MUST call pulls.get (live GitHub check), not rely on stored state.
    expect(prGetCallCount).toBe(1);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
  });

  it("forwards owner/repo and pull_number to Octokit correctly", async () => {
    const sessions = [makePrOpenSession({ sessionId: "s_pr_42", prNumber: 42 })];

    const calledPrNumbers: number[] = [];
    const octokit = makeFakeOctokit({
      prResponses: { 42: { merged: true, merged_at: "2026-05-14T00:00:00Z" } },
      onCall: (n) => {
        calledPrNumbers.push(n);
      },
    });
    await runMergeStateSweep(octokit, OWNER, REPO, makeDeps(sessions), GITHUB_TIMEOUT_MS);

    expect(calledPrNumbers).toEqual([42]);
  });

  // PR #1116 R1 BLOCKING #1 regression test: a hanging octokit.pulls.get must
  // abort under the timeout, record an error, and NOT block the parent
  // Promise.all chunk indefinitely (which would leave isRunning=true and
  // cause skip_reentrant on subsequent ticks).
  it("aborts on octokit hang via withTimeout (PR #1116 R1 BLOCKING #1)", async () => {
    const sessions = [makePrOpenSession({ sessionId: "s_hang", prNumber: 99 })];

    // Build a fake Octokit whose pulls.get hangs forever unless aborted.
    const hangingOctokit = {
      rest: {
        pulls: {
          get: async (args: {
            owner: string;
            repo: string;
            pull_number: number;
            request?: { signal?: AbortSignal };
          }) => {
            return new Promise((_resolve, reject) => {
              const signal = args.request?.signal;
              if (signal) {
                signal.addEventListener("abort", () => reject(new Error("aborted")));
              }
              // Never resolve otherwise.
            });
          },
        },
      },
    } as unknown as Parameters<typeof runMergeStateSweep>[0];

    const SHORT_TIMEOUT_MS = 50;
    const start = performance.now();
    const result = await runMergeStateSweep(
      hangingOctokit,
      OWNER,
      REPO,
      makeDeps(sessions),
      SHORT_TIMEOUT_MS
    );
    const elapsed = performance.now() - start;

    // Timeout must fire well within a couple multiples of the configured budget.
    expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS * 20);
    // The hung session is recorded as an error rather than silently dropped or
    // hanging the cycle. The parent Promise.all releases and the function
    // returns normally — this IS the regression assertion: function-returns =
    // isRunning would be released on the parent caller side.
    expect(result.sessionsScanned).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.missedSyncs).toBe(0);
    expect(result.syncsTriggered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — skips sessions without PR number
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — skips sessions without PR number", () => {
  it("skips a PR_OPEN session that has no pullRequest.number", async () => {
    const sessions: SessionRecord[] = [
      // No pullRequest at all
      makePrOpenSession({ sessionId: "s4", taskId: "mt#400" }),
      // Has pullRequest but no number — use a record with an empty-ish pullRequest
      {
        sessionId: "s5",
        taskId: "mt#500",
        status: "PR_OPEN" as SessionRecord["status"],
        // pullRequest present but number set to 0 (falsy) — sweeper skips falsy PR numbers
        pullRequest: undefined,
      } as SessionRecord,
    ];

    let octokitCalls = 0;

    const octokit = makeFakeOctokit({
      prResponses: {},
      onCall: () => {
        octokitCalls++;
      },
    });
    const result = await runMergeStateSweep(
      octokit,
      OWNER,
      REPO,
      makeDeps(sessions),
      GITHUB_TIMEOUT_MS
    );

    expect(result.sessionsScanned).toBe(2);
    expect(result.missedSyncs).toBe(0);
    expect(octokitCalls).toBe(0); // never call Octokit when PR number is missing
  });
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — handles multiple sessions
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — handles multiple sessions", () => {
  it("processes multiple sessions in parallel, applies sync to all merged ones", async () => {
    const sessions = [
      makePrOpenSession({ sessionId: "sa", taskId: "mt#1", prNumber: 1 }),
      makePrOpenSession({ sessionId: "sb", taskId: "mt#2", prNumber: 2 }),
      makePrOpenSession({ sessionId: "sc", taskId: "mt#3", prNumber: 3 }),
    ];

    const syncCalledFor: string[] = [];
    const deps = makeDeps(sessions, async (params) => {
      syncCalledFor.push(params.sessionId);
    });

    const octokit = makeFakeOctokit({
      prResponses: {
        1: { merged: true, merged_at: "2026-05-06T10:00:00Z", merge_commit_sha: "aaa" },
        2: { merged: false },
        3: { merged: true, merged_at: "2026-05-06T11:00:00Z", merge_commit_sha: "ccc" },
      },
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, deps, GITHUB_TIMEOUT_MS);

    expect(result.sessionsScanned).toBe(3);
    expect(result.missedSyncs).toBe(2);
    expect(result.syncsTriggered).toBe(2);
    expect(syncCalledFor.sort()).toEqual(["sa", "sc"]);
  });
});

// ---------------------------------------------------------------------------
// runMergeStateSweep — error handling
// ---------------------------------------------------------------------------

describe("runMergeStateSweep — error handling", () => {
  it("returns errors array and continues when sessionProvider.listSessions throws", async () => {
    const failingProvider: SessionProviderInterface = {
      listSessions: async () => {
        throw new Error("DB unavailable");
      },
    } as unknown as SessionProviderInterface;

    const deps: MergeStateSweeperDeps = {
      sessionProvider: failingProvider,
      taskService: fakeTaskService,
      applySyncFn: async () => {},
    };

    const octokit = makeFakeOctokit({ prResponses: {} });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, deps, GITHUB_TIMEOUT_MS);

    // Should surface the error gracefully
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sessionsScanned).toBe(0);
  });

  it("continues sweep even when a single session's Octokit lookup fails", async () => {
    const sessions = [
      makePrOpenSession({ sessionId: "se1", prNumber: 1 }),
      makePrOpenSession({ sessionId: "se2", prNumber: 2 }),
    ];

    const syncCalledFor: string[] = [];
    const deps = makeDeps(sessions, async (params) => {
      syncCalledFor.push(params.sessionId);
    });

    const octokit = makeFakeOctokit({
      // se1's Octokit lookup throws; se2 is merged.
      prResponses: { 2: { merged: true, merged_at: "2026-05-06T10:00:00Z" } },
      throwForPrNumber: 1,
    });
    const result = await runMergeStateSweep(octokit, OWNER, REPO, deps, GITHUB_TIMEOUT_MS);

    // se1 failed (recorded as error), se2 still synced
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.missedSyncs).toBe(1);
    expect(result.syncsTriggered).toBe(1);
    expect(syncCalledFor).toContain("se2");
  });
});

// ---------------------------------------------------------------------------
// loadMergeStateSweeperConfig — env-var tests
// ---------------------------------------------------------------------------

describe("loadMergeStateSweeperConfig", () => {
  it("defaults to enabled=true when env var not set (mt#1811)", () => {
    const saved = process.env[ENV_SWEEPER_ENABLED];
    delete process.env[ENV_SWEEPER_ENABLED];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.enabled).toBe(true);
    } finally {
      if (saved !== undefined) process.env[ENV_SWEEPER_ENABLED] = saved;
    }
  });

  // PR #1116 R1 BLOCKING #2: surface defaulted-coords risk.
  it("flags ownerDefaulted=true when SWEEPER_REPO_OWNER not set (PR #1116 R1)", () => {
    const saved = process.env[ENV_SWEEPER_REPO_OWNER];
    delete process.env[ENV_SWEEPER_REPO_OWNER];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.ownerDefaulted).toBe(true);
      expect(cfg.owner).toBe("edobry");
    } finally {
      if (saved !== undefined) process.env[ENV_SWEEPER_REPO_OWNER] = saved;
    }
  });

  it("flags ownerDefaulted=false when SWEEPER_REPO_OWNER explicitly set (PR #1116 R1)", () => {
    const saved = process.env[ENV_SWEEPER_REPO_OWNER];
    process.env[ENV_SWEEPER_REPO_OWNER] = "someorg";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.ownerDefaulted).toBe(false);
      expect(cfg.owner).toBe("someorg");
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_REPO_OWNER] = saved;
      } else {
        delete process.env[ENV_SWEEPER_REPO_OWNER];
      }
    }
  });

  it("flags repoDefaulted accordingly (PR #1116 R1)", () => {
    const savedRepo = process.env[ENV_SWEEPER_REPO_NAME];
    delete process.env[ENV_SWEEPER_REPO_NAME];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.repoDefaulted).toBe(true);
      expect(cfg.repo).toBe("minsky");
    } finally {
      if (savedRepo !== undefined) process.env[ENV_SWEEPER_REPO_NAME] = savedRepo;
    }
  });

  it("defaults githubTimeoutMs to 30_000 when env var not set (PR #1116 R1)", () => {
    const saved = process.env[ENV_GITHUB_TIMEOUT_MS];
    delete process.env[ENV_GITHUB_TIMEOUT_MS];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.githubTimeoutMs).toBe(30_000);
    } finally {
      if (saved !== undefined) process.env[ENV_GITHUB_TIMEOUT_MS] = saved;
    }
  });

  it("throws on non-numeric MERGE_STATE_SWEEPER_GITHUB_TIMEOUT_MS (PR #1116 R1)", () => {
    const saved = process.env[ENV_GITHUB_TIMEOUT_MS];
    process.env[ENV_GITHUB_TIMEOUT_MS] = "not_a_number";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_GITHUB_TIMEOUT_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_GITHUB_TIMEOUT_MS] = saved;
      } else {
        delete process.env[ENV_GITHUB_TIMEOUT_MS];
      }
    }
  });

  it("defaults to 600000ms interval", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    delete process.env[ENV_SWEEPER_INTERVAL_MS];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.intervalMs).toBe(600_000);
    } finally {
      if (saved !== undefined) process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
    }
  });

  it("reads custom interval from env var", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "30000";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.intervalMs).toBe(30_000);
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on non-numeric MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "ten_minutes";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on negative MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "-5";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });

  it("throws on zero MERGE_STATE_SWEEPER_INTERVAL_MS (mt#1811 R1 BLOCKING fix)", () => {
    const saved = process.env[ENV_SWEEPER_INTERVAL_MS];
    process.env[ENV_SWEEPER_INTERVAL_MS] = "0";
    try {
      expect(() => loadMergeStateSweeperConfig()).toThrow(
        /MERGE_STATE_SWEEPER_INTERVAL_MS must be a positive integer/
      );
    } finally {
      if (saved !== undefined) {
        process.env[ENV_SWEEPER_INTERVAL_MS] = saved;
      } else {
        delete process.env[ENV_SWEEPER_INTERVAL_MS];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// startMergeStateSweeper — lifecycle tests
// ---------------------------------------------------------------------------

describe("startMergeStateSweeper", () => {
  it("returns null when disabled", () => {
    const handle = startMergeStateSweeper(BASE_REVIEWER_CONFIG, {
      enabled: false,
      intervalMs: 600_000,
      owner: OWNER,
      repo: REPO,
      ownerDefaulted: false,
      repoDefaulted: false,
      githubTimeoutMs: GITHUB_TIMEOUT_MS,
      // mt#2684: off here — this test never reaches the boot catch-up branch
      // (the `enabled` guard returns first), but the field is required.
      bootCatchupEnabled: false,
    });
    expect(handle).toBeNull();
  });

  it("returns null when enabled but domain services deps not provided", () => {
    // After mt#2121: the sweeper requires domain services deps (sessionProvider +
    // taskService), not MCP credentials. Returns null when deps are absent.
    const handle = startMergeStateSweeper(
      BASE_REVIEWER_CONFIG,
      {
        enabled: true,
        intervalMs: 600_000,
        owner: OWNER,
        repo: REPO,
        ownerDefaulted: false,
        repoDefaulted: false,
        githubTimeoutMs: GITHUB_TIMEOUT_MS,
        // mt#2684: off here — this test never reaches the boot catch-up
        // branch (the missing-deps guard returns first).
        bootCatchupEnabled: false,
      }
      // deps intentionally omitted — should return null
    );
    expect(handle).toBeNull();
  });

  it("returns an interval handle when properly configured with domain services", () => {
    const handle = startMergeStateSweeper(
      BASE_REVIEWER_CONFIG,
      {
        enabled: true,
        intervalMs: 600_000,
        owner: OWNER,
        repo: REPO,
        ownerDefaulted: false,
        repoDefaulted: false,
        githubTimeoutMs: GITHUB_TIMEOUT_MS,
        // mt#2684: off here — no octokitOverride is supplied in this test, so
        // a boot catch-up cycle would call the real createOctokit() (a live
        // GitHub App auth handshake) in the background. Dedicated boot
        // catch-up tests below opt back in explicitly with an octokitOverride.
        bootCatchupEnabled: false,
      },
      {
        sessionProvider: makeSessionProvider([]),
        taskService: fakeTaskService,
        applySyncFn: async () => {},
      }
    );
    expect(handle).not.toBeNull();
    // Clean up the interval so the test process can exit cleanly.
    if (handle) clearInterval(handle);
  });
});

// ---------------------------------------------------------------------------
// startMergeStateSweeper — boot catch-up sweep (mt#2684)
// ---------------------------------------------------------------------------

const EVENT_CYCLE_END = "merge_state_sweeper.cycle_end";

/**
 * Poll `logs` until `findLogEvent` finds `eventName` or `maxMs` elapses.
 *
 * Mirrors sweeper.test.ts's mt#2660 boot-catch-up polling helper: the boot
 * catch-up cycle is fire-and-forget (chained off the octokitOverride promise
 * + listSessions()), so a flat `setTimeout` wait would be sensitive to
 * CI/scheduler jitter. In practice this resolves within a couple of `stepMs`
 * ticks since the underlying work here is already-resolved fake promises;
 * `maxMs` is a generous ceiling, not the expected wait — widened to 3000ms
 * (from an initial 500ms) per reviewer non-blocking nit: 500ms left little
 * headroom for scheduler jitter under CI load. Early-exit polling (5ms
 * steps) means a healthy run still returns in a couple ticks; only a truly
 * stalled cycle pays the full ceiling.
 */
async function waitForLogEvent(
  logs: string[],
  eventName: string,
  maxMs = 3_000
): Promise<Record<string, unknown> | null> {
  const stepMs = 5;
  for (let waited = 0; waited < maxMs; waited += stepMs) {
    const found = findLogEvent(logs, eventName);
    if (found) return found;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return findLogEvent(logs, eventName);
}

describe("loadMergeStateSweeperConfig — boot catch-up opt-out (mt#2684)", () => {
  const BOOT_CATCHUP_ENV_VAR = "MERGE_STATE_SWEEPER_BOOT_CATCHUP_ENABLED";

  it("bootCatchupEnabled defaults to true when env var is not set", () => {
    const saved = process.env[BOOT_CATCHUP_ENV_VAR];
    delete process.env[BOOT_CATCHUP_ENV_VAR];
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.bootCatchupEnabled).toBe(true);
    } finally {
      if (saved !== undefined) process.env[BOOT_CATCHUP_ENV_VAR] = saved;
    }
  });

  it("bootCatchupEnabled=false when env var is explicitly false", () => {
    const saved = process.env[BOOT_CATCHUP_ENV_VAR];
    process.env[BOOT_CATCHUP_ENV_VAR] = "false";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.bootCatchupEnabled).toBe(false);
    } finally {
      if (saved !== undefined) {
        process.env[BOOT_CATCHUP_ENV_VAR] = saved;
      } else {
        delete process.env[BOOT_CATCHUP_ENV_VAR];
      }
    }
  });

  it("bootCatchupEnabled=true when env var is explicitly true", () => {
    const saved = process.env[BOOT_CATCHUP_ENV_VAR];
    process.env[BOOT_CATCHUP_ENV_VAR] = "true";
    try {
      const cfg = loadMergeStateSweeperConfig();
      expect(cfg.bootCatchupEnabled).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env[BOOT_CATCHUP_ENV_VAR] = saved;
      } else {
        delete process.env[BOOT_CATCHUP_ENV_VAR];
      }
    }
  });
});

describe("startMergeStateSweeper — boot catch-up sweep (mt#2684)", () => {
  // Long interval — if the immediate boot cycle didn't fire, no
  // merge_state_sweeper.cycle_end would ever appear within a test's lifetime.
  const BASE_BOOT_SWEEPER_CONFIG: MergeStateSweeperConfig = {
    enabled: true,
    intervalMs: 3_600_000,
    owner: OWNER,
    repo: REPO,
    ownerDefaulted: false,
    repoDefaulted: false,
    githubTimeoutMs: GITHUB_TIMEOUT_MS,
    bootCatchupEnabled: true,
  };

  it("bootCatchupEnabled=true: runs a sweep cycle immediately at boot, without waiting for the interval", async () => {
    const { logs, restore } = captureConsoleLogs();
    let handle: ReturnType<typeof setInterval> | null = null;
    try {
      const octokit = makeFakeOctokit({ prResponses: {} });
      handle = startMergeStateSweeper(
        BASE_REVIEWER_CONFIG,
        BASE_BOOT_SWEEPER_CONFIG,
        makeDeps([]),
        octokit
      );

      await waitForLogEvent(logs, EVENT_CYCLE_END);
    } finally {
      if (handle) clearInterval(handle);
      restore();
    }

    expect(findLogEvent(logs, "merge_state_sweeper.boot_catchup_start")).not.toBeNull();
    expect(findLogEvent(logs, "merge_state_sweeper.cycle_start")).not.toBeNull();
    expect(findLogEvent(logs, EVENT_CYCLE_END)).not.toBeNull();
  });

  it("bootCatchupEnabled=false: does NOT run a sweep cycle at boot; only the periodic tick would", async () => {
    const { logs, restore } = captureConsoleLogs();
    let handle: ReturnType<typeof setInterval> | null = null;
    try {
      const octokit = makeFakeOctokit({ prResponses: {} });
      handle = startMergeStateSweeper(
        BASE_REVIEWER_CONFIG,
        { ...BASE_BOOT_SWEEPER_CONFIG, bootCatchupEnabled: false },
        makeDeps([]),
        octokit
      );

      // No wait needed here: with bootCatchupEnabled=false, runCycle() is
      // never called from startMergeStateSweeper — there is no async work in
      // flight to wait for, so asserting immediately is both correct and
      // non-flaky.
      expect(findLogEvent(logs, "merge_state_sweeper.boot_catchup_skipped")).not.toBeNull();
    } finally {
      if (handle) clearInterval(handle);
      restore();
    }

    expect(findLogEvent(logs, "merge_state_sweeper.boot_catchup_start")).toBeNull();
    expect(findLogEvent(logs, "merge_state_sweeper.cycle_start")).toBeNull();
  });

  it("boot catch-up detects and syncs a missed merge immediately (mt#2684 acceptance scenario)", async () => {
    const { logs, restore } = captureConsoleLogs();
    let handle: ReturnType<typeof setInterval> | null = null;
    const sessions = [
      makePrOpenSession({ sessionId: "s_boot", taskId: "mt#2684", prNumber: 2684 }),
    ];
    const syncCalledFor: string[] = [];
    try {
      const octokit = makeFakeOctokit({
        prResponses: {
          2684: {
            merged: true,
            merged_at: "2026-07-08T00:00:00Z",
            merge_commit_sha: "boot1234",
          },
        },
      });
      handle = startMergeStateSweeper(
        BASE_REVIEWER_CONFIG,
        BASE_BOOT_SWEEPER_CONFIG,
        makeDeps(sessions, async (params) => {
          syncCalledFor.push(params.sessionId);
        }),
        octokit
      );

      await waitForLogEvent(logs, EVENT_CYCLE_END);
    } finally {
      if (handle) clearInterval(handle);
      restore();
    }

    // The boot cycle fires immediately, without waiting for the (1-hour)
    // interval, and processes the missed merge in one pass.
    expect(syncCalledFor).toEqual(["s_boot"]);
    const cycleEnd = findLogEvent(logs, EVENT_CYCLE_END);
    expect(cycleEnd?.syncsTriggered).toBe(1);
    expect(cycleEnd?.missedSyncs).toBe(1);
  });
});
