/**
 * Hermetic tests for `runReviewerWatchCycle` and the alert formatters.
 *
 * Injects a fake `MissedReviewClient`, a spy `OperatorNotify`, and a real
 * `MissedReviewDedupState`. Asserts on dedup decisions, alert payload shape,
 * and notification-failure containment.
 */

import { describe, expect, test } from "bun:test";
import type { OperatorNotify } from "../notify/operator-notify";
import { MissedReviewDedupState } from "./dedup";
import type { MissedReviewClient, OpenPR, PRReviewSummary } from "./detector";
import {
  REASON_COMMIT_ID_MISMATCH,
  REASON_NO_REVIEW_BY_BOT,
  type ReviewerWatchConfig,
} from "./types";
import { formatAlertBody, formatAlertTitle, runReviewerWatchCycle } from "./watcher";

const BOT_LOGIN = "minsky-reviewer[bot]";

class SpyOperatorNotify implements OperatorNotify {
  bellCalls = 0;
  notifyCalls: Array<{ title: string; body: string }> = [];
  shouldThrow: Error | null = null;

  bell(): void {
    this.bellCalls += 1;
  }
  notify(title: string, body: string): void {
    if (this.shouldThrow) throw this.shouldThrow;
    this.notifyCalls.push({ title, body });
  }
}

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

const config: ReviewerWatchConfig = {
  owner: "owner",
  repo: "repo",
  botLogin: BOT_LOGIN,
  threshold: 1,
};

const samplePR = (overrides: Partial<OpenPR> = {}): OpenPR => ({
  number: 100,
  headSha: "abc1234567890",
  authorLogin: "alice",
  htmlUrl: "https://github.com/owner/repo/pull/100",
  draft: false,
  ...overrides,
});

describe("runReviewerWatchCycle", () => {
  test("none-missing path: no alert, no operator-notify calls", async () => {
    const pr = samplePR();
    const client = makeClient({
      prs: [pr],
      reviews: {
        100: [{ reviewerLogin: BOT_LOGIN, commitId: pr.headSha, state: "APPROVED" }],
      },
    });
    const operatorNotify = new SpyOperatorNotify();
    const dedupState = new MissedReviewDedupState();

    const result = await runReviewerWatchCycle({ client, operatorNotify, dedupState, config });

    expect(result.decision).toBe("none-missing");
    expect(result.alerted).toBe(false);
    expect(operatorNotify.bellCalls).toBe(0);
    expect(operatorNotify.notifyCalls).toHaveLength(0);
  });

  test("new-condition fires bell + notify with correct title and body", async () => {
    const pr = samplePR({
      number: 7,
      headSha: "deadbeefcafe",
      htmlUrl: "https://github.com/owner/repo/pull/7",
    });
    const client = makeClient({ prs: [pr], reviews: { 7: [] } });
    const operatorNotify = new SpyOperatorNotify();
    const dedupState = new MissedReviewDedupState();

    const result = await runReviewerWatchCycle({ client, operatorNotify, dedupState, config });

    expect(result.decision).toBe("new-condition");
    expect(result.alerted).toBe(true);
    expect(operatorNotify.bellCalls).toBe(1);
    expect(operatorNotify.notifyCalls).toHaveLength(1);
    const call = operatorNotify.notifyCalls[0];
    expect(call?.title).toBe("Minsky reviewer-bot: 1 missed review");
    expect(call?.body).toContain("PR #7");
    expect(call?.body).toContain("no review by reviewer bot");
    expect(call?.body).toContain("deadbee"); // 7-char SHA prefix
    expect(call?.body).toContain("https://github.com/owner/repo/pull/7");
  });

  test("two consecutive cycles with same misses: first fires, second is unchanged", async () => {
    const pr = samplePR();
    const client = makeClient({ prs: [pr], reviews: { 100: [] } });
    const operatorNotify = new SpyOperatorNotify();
    const dedupState = new MissedReviewDedupState();

    const first = await runReviewerWatchCycle({ client, operatorNotify, dedupState, config });
    const second = await runReviewerWatchCycle({ client, operatorNotify, dedupState, config });

    expect(first.decision).toBe("new-condition");
    expect(first.alerted).toBe(true);
    expect(second.decision).toBe("unchanged");
    expect(second.alerted).toBe(false);
    expect(operatorNotify.notifyCalls).toHaveLength(1); // only the first fired
  });

  test("threshold of 2: single missed PR is below-threshold, no alert", async () => {
    const pr = samplePR();
    const client = makeClient({ prs: [pr], reviews: { 100: [] } });
    const operatorNotify = new SpyOperatorNotify();
    const dedupState = new MissedReviewDedupState();

    const result = await runReviewerWatchCycle({
      client,
      operatorNotify,
      dedupState,
      config: { ...config, threshold: 2 },
    });

    expect(result.decision).toBe("below-threshold");
    expect(result.alerted).toBe(false);
    expect(operatorNotify.notifyCalls).toHaveLength(0);
  });

  test("operatorNotify failure does not throw out of the cycle (alerted=false)", async () => {
    const pr = samplePR();
    const client = makeClient({ prs: [pr], reviews: { 100: [] } });
    const operatorNotify = new SpyOperatorNotify();
    operatorNotify.shouldThrow = new Error("notify subprocess failed");
    const dedupState = new MissedReviewDedupState();

    const result = await runReviewerWatchCycle({ client, operatorNotify, dedupState, config });

    expect(result.decision).toBe("new-condition");
    expect(result.alerted).toBe(false); // notify threw, so we report alerted=false
    expect(operatorNotify.bellCalls).toBe(1); // bell ran first, succeeded
  });
});

describe("formatAlertTitle / formatAlertBody", () => {
  test("title pluralizes for multiple misses", () => {
    expect(formatAlertTitle([])).toBe("Minsky reviewer-bot: 0 missed reviews");
    expect(
      formatAlertTitle([
        {
          number: 1,
          headSha: "a",
          authorLogin: "x",
          reason: REASON_NO_REVIEW_BY_BOT,
          htmlUrl: "https://example.com/1",
        },
      ])
    ).toBe("Minsky reviewer-bot: 1 missed review");
    expect(
      formatAlertTitle([
        {
          number: 1,
          headSha: "a",
          authorLogin: "x",
          reason: REASON_NO_REVIEW_BY_BOT,
          htmlUrl: "https://example.com/1",
        },
        {
          number: 2,
          headSha: "b",
          authorLogin: "y",
          reason: REASON_COMMIT_ID_MISMATCH,
          htmlUrl: "https://example.com/2",
        },
      ])
    ).toBe("Minsky reviewer-bot: 2 missed reviews");
  });

  test("body lists each PR with reason, SHA prefix, and URL", () => {
    const body = formatAlertBody([
      {
        number: 42,
        headSha: "abcdef1234567890",
        authorLogin: "alice",
        reason: REASON_NO_REVIEW_BY_BOT,
        htmlUrl: "https://github.com/owner/repo/pull/42",
      },
      {
        number: 99,
        headSha: "deadbeefcafe9999",
        authorLogin: "bob",
        reason: REASON_COMMIT_ID_MISMATCH,
        htmlUrl: "https://github.com/owner/repo/pull/99",
      },
    ]);

    expect(body).toContain("PR #42");
    expect(body).toContain("no review by reviewer bot");
    expect(body).toContain("abcdef1");
    expect(body).toContain("https://github.com/owner/repo/pull/42");
    expect(body).toContain("PR #99");
    expect(body).toContain("review not at HEAD (commit_id mismatch)");
    expect(body).toContain("deadbee");
  });
});
