/**
 * Tests for the periodic sweeper (mt#1260).
 *
 * All external I/O (octokit calls, getAppIdentity, createOctokit, runReview)
 * is avoided by injecting fake SweeperDeps via the depsOverride parameter of
 * runSweep. Tests are fully hermetic — no module mocking required.
 *
 * Test scenarios:
 *   - Detection: PR with no bot review at HEAD → flagged as missing
 *   - Idempotent: second sweep after first finds zero missing
 *   - Tier-skip: PR routing to skip (Tier 1) → not flagged
 *   - Mismatch: bot reviewed but at an older commit_id → still flagged
 *   - Dismissed: bot review at HEAD but DISMISSED → still flagged
 *   - Retrigger: runReview called for each missing PR
 */

import { describe, test, expect, mock } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { ReviewerConfig } from "./config";
import {
  detectMissingReview,
  listOpenPRs,
  runSweep,
  type SweeperConfig,
  type SweeperDeps,
} from "./sweeper";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: ReviewerConfig = {
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
};

const SWEEPER_CONFIG: SweeperConfig = {
  owner: "edobry",
  repo: "minsky",
  intervalMs: 600000,
  enabled: true,
};

const BOT_LOGIN = "minsky-reviewer[bot]";
const HEAD_SHA = "abc123def456";
const OLD_SHA = "000000000000";
const TIER3_BODY = "<!-- minsky:tier=3 -->";
const TIER1_BODY = "<!-- minsky:tier=1 -->";
const TIER2_BODY = "<!-- minsky:tier=2 -->";
const REASON_NO_REVIEW = "no_review_by_bot" as const;
const PR_AUTHOR = "test-author";

// ---------------------------------------------------------------------------
// Fake Octokit builder
// ---------------------------------------------------------------------------

/**
 * A single review entry in the fake Octokit's review store.
 * Mirrors the fields detectMissingReview reads.
 */
interface FakeReview {
  user: { login: string } | null;
  commit_id: string;
  state: string;
}

/**
 * A single PR entry in the fake Octokit's PR store.
 * Mirrors the fields listOpenPRs reads.
 */
interface FakePR {
  number: number;
  head: { sha: string };
  body: string | null;
  user: { login: string } | null;
}

interface FakeOctokitOptions {
  openPRs?: FakePR[];
  reviews?: Record<number, FakeReview[]>;
}

/** Create a minimal fake Octokit with configurable paginate behavior. */
function makeFakeOctokit(options: FakeOctokitOptions): Octokit {
  const paginateFn = mock((endpoint: unknown, params?: unknown) => {
    const endpointParams = params as Record<string, unknown> | undefined;

    if (endpointParams && "pull_number" in endpointParams) {
      // listReviews call — keyed by pull_number
      const prNumber = endpointParams["pull_number"] as number;
      return Promise.resolve(options.reviews?.[prNumber] ?? []);
    }

    if (endpointParams && "state" in endpointParams) {
      // pulls.list call
      return Promise.resolve(options.openPRs ?? []);
    }

    return Promise.resolve([]);
  });

  return {
    paginate: paginateFn,
    rest: {
      pulls: {
        list: {} as unknown,
        listReviews: {} as unknown,
      },
    },
  } as unknown as Octokit;
}

/** Build a SweeperDeps with the given fake octokit, standard bot login, and optional runReviewFn. */
function makeFakeDeps(
  options: FakeOctokitOptions,
  botLogin = BOT_LOGIN,
  runReviewFn?: SweeperDeps["runReviewFn"]
): SweeperDeps {
  return {
    octokit: makeFakeOctokit(options),
    botLogin,
    runReviewFn,
  };
}

// ---------------------------------------------------------------------------
// detectMissingReview — unit tests
// ---------------------------------------------------------------------------

describe("detectMissingReview", () => {
  test("detection: no bot review at HEAD → returns MissingReviewPR with reason no_review_by_bot", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [], // No reviews at all
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).not.toBeNull();
    expect(result?.number).toBe(42);
    expect(result?.headSha).toBe(HEAD_SHA);
    expect(result?.authorLogin).toBe(PR_AUTHOR);
    expect(result?.reason).toBe(REASON_NO_REVIEW);
  });

  test("mismatch: bot reviewed but at older commit_id → returns MissingReviewPR with reason commit_id_mismatch", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: BOT_LOGIN },
            commit_id: OLD_SHA, // Older SHA, not the current HEAD
            state: "COMMENTED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("commit_id_mismatch");
    expect(result?.headSha).toBe(HEAD_SHA);
  });

  test("bot reviewed at current HEAD SHA → returns null (no action needed)", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: BOT_LOGIN },
            commit_id: HEAD_SHA, // Matches HEAD
            state: "COMMENTED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).toBeNull();
  });

  test("other user reviewed at HEAD but not bot → still flagged", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: "human-reviewer" },
            commit_id: HEAD_SHA,
            state: "APPROVED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(REASON_NO_REVIEW);
  });

  test("bot review login comparison is case-insensitive", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: "MINSKY-REVIEWER[BOT]" }, // Different case
            commit_id: HEAD_SHA,
            state: "COMMENTED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    // Should match because comparison is case-insensitive
    expect(result).toBeNull();
  });

  test("DISMISSED bot review at HEAD → still flagged (dismissed reviews don't count)", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: BOT_LOGIN },
            commit_id: HEAD_SHA, // Matches HEAD but dismissed
            state: "DISMISSED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).not.toBeNull();
    expect(result?.reason).toBe(REASON_NO_REVIEW);
  });

  test("DISMISSED bot review + non-dismissed review at HEAD → not flagged", async () => {
    const octokit = makeFakeOctokit({
      reviews: {
        42: [
          {
            user: { login: BOT_LOGIN },
            commit_id: OLD_SHA,
            state: "DISMISSED",
          },
          {
            user: { login: BOT_LOGIN },
            commit_id: HEAD_SHA,
            state: "COMMENTED",
          },
        ],
      },
    });

    const result = await detectMissingReview(
      octokit,
      "edobry",
      "minsky",
      42,
      HEAD_SHA,
      BOT_LOGIN,
      PR_AUTHOR
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listOpenPRs — unit tests
// ---------------------------------------------------------------------------

describe("listOpenPRs", () => {
  test("returns mapped PRs with number, headSha, body, authorLogin", async () => {
    const octokit = makeFakeOctokit({
      openPRs: [
        { number: 1, head: { sha: "sha1" }, body: TIER3_BODY, user: { login: "author1" } },
        { number: 2, head: { sha: "sha2" }, body: null, user: null },
      ],
    });

    const result = await listOpenPRs(octokit, "edobry", "minsky");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      number: 1,
      headSha: "sha1",
      body: TIER3_BODY,
      authorLogin: "author1",
    });
    expect(result[1]).toEqual({ number: 2, headSha: "sha2", body: "", authorLogin: "" });
  });

  test("returns empty array when no open PRs", async () => {
    const octokit = makeFakeOctokit({ openPRs: [] });

    const result = await listOpenPRs(octokit, "edobry", "minsky");

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSweep — integration tests (injected fake deps, no module mocking)
// ---------------------------------------------------------------------------

describe("runSweep", () => {
  test("detection: PR with no bot review → appears in missing list", async () => {
    const deps = makeFakeDeps({
      openPRs: [
        { number: 10, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: { 10: [] },
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.prsScanned).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.number).toBe(10);
    expect(result.missing[0]?.reason).toBe(REASON_NO_REVIEW);
  });

  test("idempotent: second sweep finds zero missing when bot has reviewed at HEAD", async () => {
    // First sweep: no review
    const firstDeps = makeFakeDeps({
      openPRs: [
        { number: 10, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: { 10: [] },
    });

    const firstResult = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, firstDeps);
    expect(firstResult.missing).toHaveLength(1);

    // Second sweep: bot has now reviewed at HEAD (simulating the retrigger completed)
    const secondDeps = makeFakeDeps({
      openPRs: [
        { number: 10, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: {
        10: [{ user: { login: BOT_LOGIN }, commit_id: HEAD_SHA, state: "COMMENTED" }],
      },
    });

    const secondResult = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, secondDeps);

    expect(secondResult.missing).toHaveLength(0);
    expect(secondResult.prsScanned).toBe(1);
  });

  test("tier-skip: Tier 1 PR → not flagged as missing even with no bot review", async () => {
    const deps = makeFakeDeps({
      openPRs: [
        // Tier 1 marker → decideRouting returns shouldReview=false
        { number: 20, head: { sha: HEAD_SHA }, body: TIER1_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: { 20: [] }, // No reviews — but should be skipped
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.prsScanned).toBe(1);
    expect(result.missing).toHaveLength(0);
  });

  test("tier-skip: Tier 2 PR with tier2Enabled=false → not flagged", async () => {
    // BASE_CONFIG has tier2Enabled=false
    const deps = makeFakeDeps({
      openPRs: [
        { number: 21, head: { sha: HEAD_SHA }, body: TIER2_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: { 21: [] },
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.missing).toHaveLength(0);
  });

  test("mismatch: bot review at old commit_id → still flagged", async () => {
    const deps = makeFakeDeps({
      openPRs: [
        { number: 30, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: {
        30: [{ user: { login: BOT_LOGIN }, commit_id: OLD_SHA, state: "COMMENTED" }],
      },
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.reason).toBe("commit_id_mismatch");
    expect(result.missing[0]?.headSha).toBe(HEAD_SHA);
  });

  test("dismissed: bot review at HEAD but DISMISSED → still flagged", async () => {
    const deps = makeFakeDeps({
      openPRs: [
        { number: 31, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: {
        31: [{ user: { login: BOT_LOGIN }, commit_id: HEAD_SHA, state: "DISMISSED" }],
      },
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.reason).toBe(REASON_NO_REVIEW);
  });

  test("multiple PRs: mix of reviewed, missing, and skipped", async () => {
    const deps = makeFakeDeps({
      openPRs: [
        // Tier 3, no review → missing
        { number: 1, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
        // Tier 3, reviewed at HEAD → OK
        { number: 2, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
        // Tier 1 → skipped regardless of review state
        { number: 3, head: { sha: HEAD_SHA }, body: TIER1_BODY, user: { login: PR_AUTHOR } },
        // Tier 3, reviewed at old SHA → commit_id mismatch
        { number: 4, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
      ],
      reviews: {
        1: [],
        2: [{ user: { login: BOT_LOGIN }, commit_id: HEAD_SHA, state: "COMMENTED" }],
        3: [],
        4: [{ user: { login: BOT_LOGIN }, commit_id: OLD_SHA, state: "COMMENTED" }],
      },
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.prsScanned).toBe(4);
    expect(result.missing).toHaveLength(2);
    const missingNumbers = result.missing.map((m) => m.number).sort();
    expect(missingNumbers).toEqual([1, 4]);
  });

  test("cycle metrics: startedAt, prsScanned, retriggeredCount populated", async () => {
    const prNumber = 5;
    const runReviewFn = mock(() =>
      Promise.resolve({
        status: "reviewed" as const,
        reason: "Posted review",
        tier: 3 as const,
      })
    );

    const deps = makeFakeDeps(
      {
        openPRs: [
          {
            number: prNumber,
            head: { sha: HEAD_SHA },
            body: TIER3_BODY,
            user: { login: PR_AUTHOR },
          },
        ],
        reviews: { [prNumber]: [] },
      },
      BOT_LOGIN,
      runReviewFn
    );

    const before = Date.now();
    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);
    const after = Date.now();

    // startedAt should be an ISO timestamp within the test window
    const startedMs = new Date(result.startedAt).getTime();
    expect(startedMs).toBeGreaterThanOrEqual(before);
    expect(startedMs).toBeLessThanOrEqual(after);

    expect(result.prsScanned).toBe(1);
    expect(result.retriggeredCount).toBe(1);
    // runReview should have been called with the right args
    expect(runReviewFn).toHaveBeenCalledTimes(1);
    expect(runReviewFn).toHaveBeenCalledWith(
      BASE_CONFIG,
      SWEEPER_CONFIG.owner,
      SWEEPER_CONFIG.repo,
      prNumber,
      PR_AUTHOR
    );
  });

  test("no open PRs: prsScanned=0, missing=[], retriggeredCount=0", async () => {
    const deps = makeFakeDeps({
      openPRs: [],
      reviews: {},
    });

    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.prsScanned).toBe(0);
    expect(result.missing).toHaveLength(0);
    expect(result.retriggeredCount).toBe(0);
  });

  test("runReview error is caught and logged, does not abort sweep", async () => {
    const runReviewFn = mock(() => Promise.reject(new Error("runReview boom")));

    const deps = makeFakeDeps(
      {
        openPRs: [
          { number: 10, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
          { number: 11, head: { sha: HEAD_SHA }, body: TIER3_BODY, user: { login: PR_AUTHOR } },
        ],
        reviews: { 10: [], 11: [] },
      },
      BOT_LOGIN,
      runReviewFn
    );

    // Should not throw even though runReview errors
    const result = await runSweep(BASE_CONFIG, SWEEPER_CONFIG, deps);

    expect(result.prsScanned).toBe(2);
    expect(result.missing).toHaveLength(2);
    // Both PRs are counted as retriggered (scheduling succeeded even if runReview threw)
    expect(result.retriggeredCount).toBe(2);
  });
});
