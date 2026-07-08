/**
 * Tests for the session.pr.drive convergence-tail subcommand (mt#2647).
 *
 * Covers each terminal state with an injected fake backend + fake clock/sleep
 * (no real network, no real waiting): APPROVE -> READY_TO_MERGE,
 * CHANGES_REQUESTED stop, COMMENT stop, checks-fail stop, checks-timeout
 * stop, and review-timeout.
 */
import { describe, expect, test } from "bun:test";
import { sessionPrDrive, type SessionPrDriveDependencies } from "./pr-drive-subcommand";
import type { ChecksResult, RepositoryBackend, ReviewListEntry } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";

const SESSION_ID = "test-session";
const PR_NUMBER = 123;
const REVIEWER_BOT = "minsky-reviewer[bot]";
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;

function mkReview(overrides: Partial<ReviewListEntry> = {}): ReviewListEntry {
  return {
    reviewId: 1,
    state: "APPROVED",
    submittedAt: "2099-01-01T00:00:00Z", // far in the future -> always >= since
    reviewerLogin: REVIEWER_BOT,
    body: "",
    ...overrides,
  };
}

const PASSED_CHECKS: ChecksResult = {
  allPassed: true,
  summary: { total: 2, passed: 2, failed: 0, pending: 0 },
  checks: [
    { name: "build", status: "completed", conclusion: "success", url: null },
    { name: "test", status: "completed", conclusion: "success", url: null },
  ],
};

const FAILED_CHECKS: ChecksResult = {
  allPassed: false,
  summary: { total: 2, passed: 1, failed: 1, pending: 0 },
  checks: [
    { name: "build", status: "completed", conclusion: "success", url: null },
    { name: "test", status: "completed", conclusion: "failure", url: null },
  ],
};

const PENDING_CHECKS: ChecksResult = {
  allPassed: false,
  summary: { total: 2, passed: 1, failed: 0, pending: 1 },
  checks: [
    { name: "build", status: "completed", conclusion: "success", url: null },
    { name: "test", status: "in_progress", conclusion: null, url: null },
  ],
};

interface MakeDepsOptions {
  reviewsQueue: ReviewListEntry[][];
  checksQueue?: ChecksResult[];
}

function makeDeps(opts: MakeDepsOptions): SessionPrDriveDependencies & {
  checksCalls: number;
} {
  let clock = 1_000_000;
  let reviewIdx = 0;
  let checksIdx = 0;

  const sessionRecord: SessionRecord = {
    session: SESSION_ID,
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(clock).toISOString(),
    pullRequest: { number: PR_NUMBER, branch: "task/mt-test", baseBranch: "main" },
    taskId: "mt#2647",
  } as unknown as SessionRecord;

  const sessionDB = {
    getSession: async (id: string) => (id === SESSION_ID ? sessionRecord : null),
  } as unknown as SessionProviderInterface;

  const checksQueue = opts.checksQueue ?? [PASSED_CHECKS];

  const backend: RepositoryBackend = {
    review: {
      listReviews: async () => {
        const next = opts.reviewsQueue[reviewIdx] ?? opts.reviewsQueue.at(-1) ?? [];
        reviewIdx++;
        return next;
      },
    },
    ci: {
      getChecksForPR: async () => {
        const next = checksQueue[checksIdx] ?? checksQueue.at(-1) ?? PASSED_CHECKS;
        checksIdx++;
        return next;
      },
    },
  } as unknown as RepositoryBackend;

  return {
    sessionDB,
    createBackend: async () => backend,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    get checksCalls() {
      return checksIdx;
    },
  } as unknown as SessionPrDriveDependencies & { checksCalls: number };
}

describe("sessionPrDrive", () => {
  test("APPROVE + all checks passed -> READY_TO_MERGE", async () => {
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [PASSED_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 30 },
      deps
    );

    expect(result.state).toBe("READY_TO_MERGE");
    if (result.state === "READY_TO_MERGE") {
      expect(result.review.state).toBe("APPROVED");
      expect(result.checks?.allPassed).toBe(true);
    }
    expect(deps.checksCalls).toBe(1);
  });

  test("skipChecks:true resolves READY_TO_MERGE without calling checks", async () => {
    const deps = makeDeps({ reviewsQueue: [[mkReview({ state: "APPROVED" })]] });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, skipChecks: true },
      deps
    );

    expect(result.state).toBe("READY_TO_MERGE");
    if (result.state === "READY_TO_MERGE") {
      expect(result.checks).toBeNull();
    }
    expect(deps.checksCalls).toBe(0);
  });

  test("CHANGES_REQUESTED stops and surfaces the trimmed review payload by default (mt#2656)", async () => {
    const review = mkReview({
      state: CHANGES_REQUESTED_STATE,
      body: [
        "## Findings",
        "",
        "- [BLOCKING] src/foo.ts:42 — Null check missing.",
        "  Full explanation.",
      ].join("\n"),
    });
    const deps = makeDeps({ reviewsQueue: [[review]] });

    const result = await sessionPrDrive({ sessionId: SESSION_ID, reviewTimeoutSeconds: 30 }, deps);

    expect(result.state).toBe(CHANGES_REQUESTED_STATE);
    if (result.state === CHANGES_REQUESTED_STATE) {
      expect("body" in result.review).toBe(false);
      expect(result.review.submittedAt).toBeDefined();
      if ("findings" in result.review) {
        expect(result.review.blockingCount).toBe(1);
        expect(result.review.findings).toHaveLength(1);
      }
    }
    expect(deps.checksCalls).toBe(0);
  });

  test("CHANGES_REQUESTED with fullBody:true restores the raw ReviewListEntry body (mt#2656)", async () => {
    const review = mkReview({
      state: CHANGES_REQUESTED_STATE,
      body: "fix the null check on line 42",
    });
    const deps = makeDeps({ reviewsQueue: [[review]] });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, fullBody: true },
      deps
    );

    expect(result.state).toBe(CHANGES_REQUESTED_STATE);
    if (result.state === CHANGES_REQUESTED_STATE) {
      expect("body" in result.review).toBe(true);
      if ("body" in result.review) {
        expect(result.review.body).toBe("fix the null check on line 42");
      }
      expect(result.review.submittedAt).toBeDefined();
    }
    expect(deps.checksCalls).toBe(0);
  });

  test("COMMENTED review stops as COMMENT — never treated as approval", async () => {
    const review = mkReview({ state: "COMMENTED", body: "looks fine, no blockers" });
    const deps = makeDeps({ reviewsQueue: [[review]] });

    const result = await sessionPrDrive({ sessionId: SESSION_ID, reviewTimeoutSeconds: 30 }, deps);

    expect(result.state).toBe("COMMENT");
    if (result.state === "COMMENT") {
      expect(result.review.state).toBe("COMMENTED");
    }
    expect(deps.checksCalls).toBe(0);
  });

  test("APPROVE + failed checks -> CHECKS_FAILED", async () => {
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [FAILED_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 30 },
      deps
    );

    expect(result.state).toBe("CHECKS_FAILED");
    if (result.state === "CHECKS_FAILED") {
      expect(result.checks.summary.failed).toBe(1);
    }
  });

  // ============================================================================
  // mt#2656 — trimmed-by-default checks payload
  // ============================================================================

  test("READY_TO_MERGE trims checks to summary-only by default (mt#2656)", async () => {
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [PASSED_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 30 },
      deps
    );

    expect(result.state).toBe("READY_TO_MERGE");
    if (result.state === "READY_TO_MERGE") {
      expect(result.checks?.allPassed).toBe(true);
      expect(result.checks?.summary.passed).toBe(2);
      expect("failingChecks" in (result.checks ?? {})).toBe(false);
      expect("checks" in (result.checks ?? {})).toBe(false);
    }
  });

  test("CHECKS_FAILED surfaces only the failing check in failingChecks, not the passing one (mt#2656)", async () => {
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [FAILED_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 30 },
      deps
    );

    expect(result.state).toBe("CHECKS_FAILED");
    if (result.state === "CHECKS_FAILED") {
      expect("failingChecks" in result.checks).toBe(true);
      if ("failingChecks" in result.checks) {
        expect(result.checks.failingChecks).toEqual([
          { name: "test", status: "completed", conclusion: "failure", url: null },
        ]);
      }
    }
  });

  test("fullBody:true restores the full per-check breakdown (mt#2656)", async () => {
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [FAILED_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 30, fullBody: true },
      deps
    );

    expect(result.state).toBe("CHECKS_FAILED");
    if (result.state === "CHECKS_FAILED") {
      expect("checks" in result.checks).toBe(true);
      if ("checks" in result.checks) {
        expect(result.checks.checks).toHaveLength(2);
      }
    }
  });

  test("APPROVE + checks never complete before deadline -> CHECKS_TIMEOUT", async () => {
    // checksTimeoutSeconds: 0 collapses the deadline to "now", so the checks
    // wait loop's `now() < deadline` guard is false immediately after the
    // first (pending) fetch — deterministic without a real wait.
    const deps = makeDeps({
      reviewsQueue: [[mkReview({ state: "APPROVED" })]],
      checksQueue: [PENDING_CHECKS],
    });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 30, checksTimeoutSeconds: 0 },
      deps
    );

    expect(result.state).toBe("CHECKS_TIMEOUT");
    if (result.state === "CHECKS_TIMEOUT") {
      expect(result.checks.timedOut).toBe(true);
    }
  });

  test("no matching review before the timeout -> REVIEW_TIMEOUT with diagnostics", async () => {
    const deps = makeDeps({ reviewsQueue: [[]] });

    const result = await sessionPrDrive(
      { sessionId: SESSION_ID, reviewTimeoutSeconds: 1, reviewIntervalSeconds: 5 },
      deps
    );

    expect(result.state).toBe("REVIEW_TIMEOUT");
    if (result.state === "REVIEW_TIMEOUT") {
      expect(result.pollCount).toBeGreaterThan(0);
      expect(result.sinceUsed).toBeDefined();
      expect(result.lastSeenReviews).toEqual([]);
    }
    expect(deps.checksCalls).toBe(0);
  });

  test("DISMISSED review is never treated as approval — UNRECOGNIZED_REVIEW_STATE", async () => {
    const review = mkReview({ state: "DISMISSED" });
    const deps = makeDeps({ reviewsQueue: [[review]] });

    const result = await sessionPrDrive({ sessionId: SESSION_ID, reviewTimeoutSeconds: 30 }, deps);

    expect(result.state).toBe("UNRECOGNIZED_REVIEW_STATE");
    expect(deps.checksCalls).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // mt#2677 regression tests — the two real incident shapes reported against
  // session_pr_drive:
  //   (2) `since` set + no qualifying review at call start -> the poll picked
  //       up a review submitted AFTER poll start, but two live instances hung
  //       to the harness's unrelated 1800s idle abort instead of returning it.
  //   (3) an explicit small `reviewTimeoutSeconds` did not fire AT ALL — the
  //       underlying I/O (a stalled GitHub fetch with no timeout of its own)
  //       hung the whole wait past its configured deadline.
  // ---------------------------------------------------------------------------
  describe("mt#2677 regressions", () => {
    test("since set + review submitted after poll start is picked up within one poll interval (incident #2 shape)", async () => {
      const since = "2026-07-08T03:23:45.000Z";
      // Submitted well after `since` AND after the poll loop's start — the
      // exact incident #2 shape (qualifying review lands ~13 min into a wait
      // that should have surfaced it on its next poll, or timed out at 600s;
      // it did neither).
      const lateReview = mkReview({
        reviewId: 99,
        state: "APPROVED",
        submittedAt: "2026-07-08T03:57:44.000Z",
      });
      const deps = makeDeps({ reviewsQueue: [[], [lateReview]] });

      const result = await sessionPrDrive(
        {
          sessionId: SESSION_ID,
          since,
          reviewTimeoutSeconds: 600,
          reviewIntervalSeconds: 15,
          skipChecks: true,
        },
        deps
      );

      expect(result.state).toBe("READY_TO_MERGE");
      if (result.state === "READY_TO_MERGE") {
        expect(result.review.reviewId).toBe(99);
      }
    });

    test("a stalled/never-resolving review fetch still returns REVIEW_TIMEOUT at reviewTimeoutSeconds wall-clock (incident #3 shape)", async () => {
      // No fake clock here on purpose: `reviewTimeoutSeconds` is bounded by a
      // REAL setTimeout inside withDeadline (mt#2677), independent of any
      // injected now/sleep test seam — exactly the wall-clock guarantee the
      // fix provides. A small real timeout (2s, well under the project's
      // 15s test-runner timeout) keeps this fast while still exercising a
      // genuine real timer, mirroring octokit-timeout.test.ts's established
      // "never-resolving base + small real timeout" pattern.
      const sessionRecord: SessionRecord = {
        session: SESSION_ID,
        repoName: "edobry-minsky",
        repoUrl: "https://github.com/edobry/minsky.git",
        createdAt: new Date().toISOString(),
        pullRequest: { number: PR_NUMBER, branch: "task/mt-test", baseBranch: "main" },
        taskId: "mt#2677",
      } as unknown as SessionRecord;

      const sessionDB = {
        getSession: async (id: string) => (id === SESSION_ID ? sessionRecord : null),
      } as unknown as SessionProviderInterface;

      const backend: RepositoryBackend = {
        review: {
          // Simulates a stalled GitHub fetch (e.g. the unbounded token-mint
          // call fixed in github-app-token-provider.ts) — never settles.
          listReviews: async () => new Promise<ReviewListEntry[]>(() => {}),
        },
      } as unknown as RepositoryBackend;

      const deps: SessionPrDriveDependencies = {
        sessionDB,
        createBackend: async () => backend,
        // Real clock/sleep — the whole point is to prove the REAL deadline
        // (not a fake-clock-simulated one) bounds the stalled call.
      };

      const start = performance.now();
      const result = await sessionPrDrive(
        { sessionId: SESSION_ID, reviewTimeoutSeconds: 2, reviewIntervalSeconds: 5 },
        deps
      );
      const elapsedMs = performance.now() - start;

      expect(result.state).toBe("REVIEW_TIMEOUT");
      // Bounded by the configured 2s deadline, not the caller's real 1800s
      // MCP idle-timeout (the actual failure mode in all three live hangs).
      expect(elapsedMs).toBeLessThan(2000 + 2000);
    });
  });
});
