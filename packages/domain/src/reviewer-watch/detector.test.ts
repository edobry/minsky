/**
 * Hermetic tests for the reviewer-watch detector.
 *
 * Mirrors the logic-coverage of `services/reviewer/src/sweeper.ts` for
 * `detectMissingReview` but on the local re-implementation. Injects a fake
 * `MissedReviewClient`; no real GitHub, no module mocking.
 */

import { describe, expect, test } from "bun:test";
import {
  detectMissingReviewForPR,
  detectMissingReviews,
  type MissedReviewClient,
  type OpenPR,
  type PRReviewSummary,
} from "./detector";
import { REASON_COMMIT_ID_MISMATCH, REASON_NO_REVIEW_BY_BOT } from "./types";

const BOT_LOGIN = "minsky-reviewer[bot]";

function makeClient(opts: {
  prs: OpenPR[];
  reviews?: Record<number, PRReviewSummary[]>;
}): MissedReviewClient {
  const reviewsByPr = opts.reviews ?? {};
  return {
    async listOpenPRs(): Promise<OpenPR[]> {
      return opts.prs;
    },
    async listReviews(_owner: string, _repo: string, prNumber: number): Promise<PRReviewSummary[]> {
      return reviewsByPr[prNumber] ?? [];
    },
  };
}

const samplePR = (overrides: Partial<OpenPR> = {}): OpenPR => ({
  number: 100,
  headSha: "abc1234567890abcdef1234567890abcdef12345",
  authorLogin: "alice",
  htmlUrl: "https://github.com/owner/repo/pull/100",
  draft: false,
  ...overrides,
});

describe("detectMissingReviewForPR", () => {
  test("flags PR with no reviews as no_review_by_bot", async () => {
    const pr = samplePR();
    const client = makeClient({ prs: [pr], reviews: { 100: [] } });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(REASON_NO_REVIEW_BY_BOT);
    expect(result?.number).toBe(100);
    expect(result?.headSha).toBe(pr.headSha);
  });

  test("flags PR whose only bot review is DISMISSED as no_review_by_bot", async () => {
    const pr = samplePR();
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: BOT_LOGIN, commitId: pr.headSha, state: "DISMISSED" }],
      },
    });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
    expect(result?.reason).toBe(REASON_NO_REVIEW_BY_BOT);
  });

  test("flags PR whose bot review is at a different SHA as commit_id_mismatch", async () => {
    const pr = samplePR({ headSha: "newshanew" });
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: BOT_LOGIN, commitId: "oldsha", state: "APPROVED" }],
      },
    });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
    expect(result?.reason).toBe(REASON_COMMIT_ID_MISMATCH);
  });

  test("returns null when bot has reviewed at HEAD (any non-dismissed state)", async () => {
    const pr = samplePR();
    for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) {
      const client = makeClient({
        prs: [pr],
        reviews: {
          100: [{ reviewerLogin: BOT_LOGIN, commitId: pr.headSha, state }],
        },
      });
      const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
      expect(result).toBeNull();
    }
  });

  test("ignores reviews from other authors", async () => {
    const pr = samplePR();
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: "human-reviewer", commitId: pr.headSha, state: "APPROVED" }],
      },
    });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
    expect(result?.reason).toBe(REASON_NO_REVIEW_BY_BOT);
  });

  test("login match is case-insensitive (mirrors sweeper.ts)", async () => {
    const pr = samplePR();
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: "MINSKY-reviewer[BOT]", commitId: pr.headSha, state: "APPROVED" }],
      },
    });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
    expect(result).toBeNull();
  });

  test("null reviewerLogin (deleted account) does not match the bot", async () => {
    const pr = samplePR();
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: null, commitId: pr.headSha, state: "APPROVED" }],
      },
    });

    const result = await detectMissingReviewForPR(client, "owner", "repo", pr, BOT_LOGIN);
    expect(result?.reason).toBe(REASON_NO_REVIEW_BY_BOT);
  });
});

describe("detectMissingReviews (full repo scan)", () => {
  test("skips draft PRs", async () => {
    const draft = samplePR({ number: 1, draft: true });
    const ready = samplePR({ number: 2 });

    const client = makeClient({
      prs: [draft, ready],
      reviews: { 1: [], 2: [] },
    });

    const result = await detectMissingReviews(client, "owner", "repo", BOT_LOGIN);
    expect(result.scanned).toBe(2);
    expect(result.missing.map((m) => m.number)).toEqual([2]);
  });

  test("returns empty missing-list when every non-draft PR has a fresh bot review", async () => {
    const pr1 = samplePR({ number: 1, headSha: "sha1" });
    const pr2 = samplePR({ number: 2, headSha: "sha2" });

    const client = makeClient({
      prs: [pr1, pr2],
      reviews: {
        1: [{ reviewerLogin: BOT_LOGIN, commitId: "sha1", state: "APPROVED" }],
        2: [{ reviewerLogin: BOT_LOGIN, commitId: "sha2", state: "CHANGES_REQUESTED" }],
      },
    });

    const result = await detectMissingReviews(client, "owner", "repo", BOT_LOGIN);
    expect(result.scanned).toBe(2);
    expect(result.missing).toHaveLength(0);
  });

  test("returns mixed reasons across multiple PRs", async () => {
    const pr1 = samplePR({ number: 1, headSha: "sha1" }); // no reviews
    const pr2 = samplePR({ number: 2, headSha: "sha2-new" }); // stale review
    const pr3 = samplePR({ number: 3, headSha: "sha3" }); // fresh review

    const client = makeClient({
      prs: [pr1, pr2, pr3],
      reviews: {
        1: [],
        2: [{ reviewerLogin: BOT_LOGIN, commitId: "sha2-old", state: "APPROVED" }],
        3: [{ reviewerLogin: BOT_LOGIN, commitId: "sha3", state: "APPROVED" }],
      },
    });

    const result = await detectMissingReviews(client, "owner", "repo", BOT_LOGIN);
    expect(result.scanned).toBe(3);
    expect(result.missing).toHaveLength(2);
    expect(result.missing[0]?.number).toBe(1);
    expect(result.missing[0]?.reason).toBe(REASON_NO_REVIEW_BY_BOT);
    expect(result.missing[1]?.number).toBe(2);
    expect(result.missing[1]?.reason).toBe(REASON_COMMIT_ID_MISMATCH);
  });
});
