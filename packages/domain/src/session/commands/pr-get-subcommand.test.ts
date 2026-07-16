/**
 * Regression test for mt#2829 PR #1970 R1 (BLOCKING finding): the
 * `reviews: true` fetch path on `sessionPrGet` must NOT collapse a fetch
 * failure into `reviews: []` — that was indistinguishable from a
 * confirmed-zero-reviews PR. A failure must surface via `reviewsFetchError`
 * instead, with `reviews` left absent.
 */
import { describe, expect, test } from "bun:test";
import { sessionPrGet } from "./pr-get-subcommand";
import type { SessionProviderInterface, SessionRecord } from "../types";
import type { RepositoryBackend, ReviewListEntry } from "../../repository/index";

const SESSION_ID = "test-session-mt2829";
const PR_NUMBER = 42;

function mkSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "edobry/minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2026-07-01T00:00:00Z",
    backendType: "github",
    pullRequest: {
      number: PR_NUMBER,
      url: `https://github.com/edobry/minsky/pull/${PR_NUMBER}`,
      state: "open",
      createdAt: "2026-07-01T00:00:00Z",
      headBranch: "task/mt-2829",
      baseBranch: "main",
      lastSynced: "2026-07-01T00:00:00Z",
      // `updatedAt` isn't part of PullRequestInfo but pr-get-subcommand.ts's
      // enrichment-trigger check does a runtime `"updatedAt" in finalPullRequest`
      // duck-type probe; including it here keeps this test on the
      // fast/no-enrichment path deterministically.
      updatedAt: "2026-07-01T00:00:00Z",
    } as unknown as SessionRecord["pullRequest"],
  };
}

function mkSessionDB(sessionRecord: SessionRecord): SessionProviderInterface {
  return {
    getSession: async (id: string) => (id === SESSION_ID ? sessionRecord : null),
    getSessionWorkdir: async () => {
      throw new Error("no workdir in this test fixture");
    },
    // Minimal stub — resolveSessionContextWithFeedback only needs getSession
    // when sessionId is passed explicitly (no auto-detection required).
  } as unknown as SessionProviderInterface;
}

function mkReview(overrides: Partial<ReviewListEntry>): ReviewListEntry {
  return {
    reviewId: 1,
    state: "APPROVED",
    submittedAt: "2026-07-15T10:00:00Z",
    reviewerLogin: "minsky-reviewer[bot]",
    body: "lgtm",
    ...overrides,
  };
}

describe("sessionPrGet reviews:true fetch-failure vs zero-reviews (mt#2829 PR #1970 R1)", () => {
  test("fetch success with reviews present: returns `reviews`, no `reviewsFetchError`", async () => {
    const sessionRecord = mkSessionRecord();
    const sessionDB = mkSessionDB(sessionRecord);
    const backend = {
      review: {
        listReviews: async () => [mkReview({ reviewId: 1 })],
        listReviewComments: async () => [],
      },
    } as unknown as RepositoryBackend;

    const result = await sessionPrGet(
      { sessionId: SESSION_ID, reviews: true },
      { sessionDB, createRepositoryBackend: async () => backend }
    );

    expect(result.reviews).toHaveLength(1);
    expect(result.reviewsFetchError).toBeUndefined();
  });

  test("fetch success with zero reviews: returns `reviews: []`, no `reviewsFetchError`", async () => {
    const sessionRecord = mkSessionRecord();
    const sessionDB = mkSessionDB(sessionRecord);
    const backend = {
      review: {
        listReviews: async () => [],
        listReviewComments: async () => [],
      },
    } as unknown as RepositoryBackend;

    const result = await sessionPrGet(
      { sessionId: SESSION_ID, reviews: true },
      { sessionDB, createRepositoryBackend: async () => backend }
    );

    expect(result.reviews).toEqual([]);
    expect(result.reviewsFetchError).toBeUndefined();
  });

  test("backend construction failure: returns `reviewsFetchError`, `reviews` is absent — NOT `[]` (the R1 regression)", async () => {
    const sessionRecord = mkSessionRecord();
    const sessionDB = mkSessionDB(sessionRecord);

    const result = await sessionPrGet(
      { sessionId: SESSION_ID, reviews: true },
      {
        sessionDB,
        createRepositoryBackend: async () => {
          throw new Error("simulated backend construction failure");
        },
      }
    );

    expect(result.reviews).toBeUndefined();
    expect(result.reviewsFetchError).toBeDefined();
    expect(result.reviewsFetchError).toContain("simulated backend construction failure");
  });

  test("listReviews failure (network/auth error): returns `reviewsFetchError`, `reviews` is absent — NOT `[]`", async () => {
    const sessionRecord = mkSessionRecord();
    const sessionDB = mkSessionDB(sessionRecord);
    const backend = {
      review: {
        listReviews: async () => {
          throw new Error("simulated GitHub API failure");
        },
        listReviewComments: async () => [],
      },
    } as unknown as RepositoryBackend;

    const result = await sessionPrGet(
      { sessionId: SESSION_ID, reviews: true },
      { sessionDB, createRepositoryBackend: async () => backend }
    );

    expect(result.reviews).toBeUndefined();
    expect(result.reviewsFetchError).toContain("simulated GitHub API failure");
    // Core PR metadata must still be present — the failure is non-fatal to the overall call.
    expect(result.pullRequest.number).toBe(PR_NUMBER);
  });

  test("reviews param not requested: neither `reviews` nor `reviewsFetchError` present", async () => {
    const sessionRecord = mkSessionRecord();
    const sessionDB = mkSessionDB(sessionRecord);

    const result = await sessionPrGet({ sessionId: SESSION_ID }, { sessionDB });

    expect(result.reviews).toBeUndefined();
    expect(result.reviewsFetchError).toBeUndefined();
    expect(result.pullRequest.number).toBe(PR_NUMBER);
  });
});
