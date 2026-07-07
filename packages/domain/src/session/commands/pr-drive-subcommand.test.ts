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

  test("CHANGES_REQUESTED stops and surfaces the review payload; never calls checks", async () => {
    const review = mkReview({
      state: CHANGES_REQUESTED_STATE,
      body: "fix the null check on line 42",
    });
    const deps = makeDeps({ reviewsQueue: [[review]] });

    const result = await sessionPrDrive({ sessionId: SESSION_ID, reviewTimeoutSeconds: 30 }, deps);

    expect(result.state).toBe(CHANGES_REQUESTED_STATE);
    if (result.state === "CHANGES_REQUESTED") {
      expect(result.review.body).toBe("fix the null check on line 42");
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
});
