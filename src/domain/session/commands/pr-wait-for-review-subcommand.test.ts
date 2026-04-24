/**
 * Tests for the session_pr_wait_for_review subcommand (mt#1203).
 *
 * Covers the polling loop, filter logic, and dependency-injection seams:
 * fake clock, fake sleep, and an injected backend whose listReviews is
 * driven by a scripted queue.
 */
import { describe, expect, test } from "bun:test";
import {
  findMatchingReview,
  sessionPrWaitForReview,
  type SessionPrWaitForReviewDependencies,
} from "./pr-wait-for-review-subcommand";
import type { ReviewListEntry, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";
import { ResourceNotFoundError, ValidationError } from "../../../errors/index";

/** Reviewer login used by test fixtures and filter-match assertions. */
const REVIEWER_BOT = "minsky-reviewer[bot]";

describe("findMatchingReview", () => {
  function mkReview(overrides: Partial<ReviewListEntry>): ReviewListEntry {
    return {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-04-24T01:00:00Z",
      reviewerLogin: "someone",
      body: "",
      ...overrides,
    };
  }

  const since = Date.parse("2026-04-24T01:00:00Z");

  test("returns the first review at or after since", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: "2026-04-24T00:59:59Z" }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T01:00:00Z" }),
        mkReview({ reviewId: 3, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("skips reviews without a submittedAt timestamp", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: undefined }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("skips reviews with unparseable timestamps", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: "not-a-date" }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("reviewer filter matches case-insensitively", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, reviewerLogin: "someone-else" }),
        mkReview({ reviewId: 2, reviewerLogin: "Minsky-Reviewer[bot]" }),
      ],
      since,
      REVIEWER_BOT
    );
    expect(r?.reviewId).toBe(2);
  });

  test("reviewer filter rejects non-matches even if review is recent", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: "someone-else" })],
      since,
      REVIEWER_BOT
    );
    expect(r).toBeUndefined();
  });

  test("reviewer filter handles null reviewerLogin", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: null })],
      since,
      REVIEWER_BOT
    );
    expect(r).toBeUndefined();
  });

  test("returns undefined on empty input", () => {
    const r = findMatchingReview([], since, undefined);
    expect(r).toBeUndefined();
  });
});

describe("sessionPrWaitForReview", () => {
  const sessionId = "test-session";
  const prNumber = 123;

  function makeDeps(
    reviewsQueue: ReviewListEntry[][],
    clockStart = 1_000_000
  ): SessionPrWaitForReviewDependencies & {
    listCalls: number;
    sleepCalls: number[];
  } {
    let clock = clockStart;
    let listIdx = 0;
    const sleepCalls: number[] = [];

    const sessionRecord: SessionRecord = {
      session: sessionId,
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date(clockStart).toISOString(),
      pullRequest: { number: prNumber, branch: "task/mt-test", baseBranch: "main" },
      taskId: "mt#1203",
    } as unknown as SessionRecord;

    const sessionDB = {
      getSession: async (id: string) => (id === sessionId ? sessionRecord : null),
    } as unknown as SessionProviderInterface;

    const backend: RepositoryBackend = {
      review: {
        listReviews: async () => {
          const next = reviewsQueue[listIdx] ?? reviewsQueue[reviewsQueue.length - 1] ?? [];
          listIdx++;
          return next;
        },
      },
    } as unknown as RepositoryBackend;

    const deps = {
      sessionDB,
      createBackend: async () => backend,
      now: () => clock,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      get listCalls() {
        return listIdx;
      },
      get sleepCalls() {
        return sleepCalls;
      },
    };

    return deps as unknown as SessionPrWaitForReviewDependencies & {
      listCalls: number;
      sleepCalls: number[];
    };
  }

  // We need to stub resolveSessionContextWithFeedback since it hits the
  // session resolver directly. The simplest reliable approach is to pass
  // sessionId explicitly, which short-circuits auto-detection.
  //
  // But resolveSessionContextWithFeedback will still try to validate the id
  // against the session DB. Our sessionDB.getSession returns the record for
  // the known id, which should be enough.

  const match: ReviewListEntry = {
    reviewId: 42,
    state: "CHANGES_REQUESTED",
    submittedAt: "2099-01-01T00:00:00Z", // far in the future → always >= since
    reviewerLogin: REVIEWER_BOT,
    body: "adversarial review body",
    htmlUrl: "https://github.com/edobry/minsky/pull/123#pullrequestreview-42",
  };

  test("returns match on the first poll when a review is already present", async () => {
    const deps = makeDeps([[match]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 30, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
      expect(result.pollCount).toBe(1);
    }
    expect(deps.sleepCalls).toHaveLength(0);
  });

  test("polls until a review appears", async () => {
    const deps = makeDeps([[], [], [match]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 60, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.pollCount).toBe(3);
    }
    // 2 sleeps between 3 polls
    expect(deps.sleepCalls).toHaveLength(2);
    expect(deps.sleepCalls[0]).toBe(5000);
  });

  test("returns matched=false on timeout with no review", async () => {
    // Queue returns empty indefinitely (makeDeps repeats last entry).
    const deps = makeDeps([[]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 10, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(false);
    // With 10s budget and 5s interval: poll, sleep 5, poll, sleep 5, poll, no
    // time left → 3 polls.
    expect(result.pollCount).toBeGreaterThanOrEqual(2);
  });

  test("reviewer filter excludes non-matching reviews", async () => {
    const unrelated: ReviewListEntry = {
      ...match,
      reviewerLogin: "some-other-bot",
      reviewId: 7,
    };
    const deps = makeDeps([[unrelated], [unrelated, match]]);
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 60,
        intervalSeconds: 5,
        reviewer: REVIEWER_BOT,
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
      expect(result.pollCount).toBe(2);
    }
  });

  test("since filter ignores pre-existing old reviews", async () => {
    const oldReview: ReviewListEntry = {
      ...match,
      reviewId: 1,
      submittedAt: "2020-01-01T00:00:00Z",
    };
    const deps = makeDeps([[oldReview], [oldReview, match]]);
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 60,
        intervalSeconds: 5,
        since: "2025-01-01T00:00:00Z",
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
    }
  });

  test("throws ResourceNotFoundError when session has no PR", async () => {
    const deps = makeDeps([[]]);
    const noPrRecord: SessionRecord = {
      session: sessionId,
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date().toISOString(),
    } as unknown as SessionRecord;
    deps.sessionDB = {
      getSession: async () => noPrRecord,
    } as unknown as SessionProviderInterface;

    await expect(
      sessionPrWaitForReview({ sessionId, timeoutSeconds: 5, intervalSeconds: 5 }, deps)
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("throws ValidationError when since is not a parseable timestamp", async () => {
    const deps = makeDeps([[]]);
    await expect(
      sessionPrWaitForReview(
        { sessionId, timeoutSeconds: 5, intervalSeconds: 5, since: "not-a-date" },
        deps
      )
    ).rejects.toThrow(ValidationError);
  });
});
