/**
 * Tests for github-client.ts — focusing on fetchPriorReviews.
 *
 * fetchPriorReviews is DI-friendly: it receives an Octokit instance, so tests
 * can pass a stub without mocking the module. No @octokit/auth-app credentials
 * are needed.
 *
 * Coverage:
 *   - Pagination: octokit.paginate is called (not the single-page listReviews)
 *   - DISMISSED filtering: DISMISSED reviews are excluded from results
 *   - PENDING filtering: PENDING reviews are excluded from results
 *   - Bot-identity predicate: only minsky-reviewer[bot] with Chinese-wall marker passes
 *   - Same-bot non-marker comments (skip-notices) are excluded
 *   - Results are sorted ascending by submittedAt (oldest first)
 *   - MAX_REVIEWS_FETCHED cap: more than 500 reviews triggers a warning and truncation
 */

import { describe, test, expect, mock, spyOn } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { CHINESE_WALL_MARKER, MINSKY_REVIEWER_BOT_LOGIN } from "./prior-review-summary";
import { fetchPriorReviews } from "./github-client";

// ---------------------------------------------------------------------------
// Fake Octokit builder
// ---------------------------------------------------------------------------

/**
 * Shape of a single review as returned by octokit.paginate(listReviews).
 * We only need the fields that fetchPriorReviews maps.
 */
interface FakeReviewData {
  id: number;
  state: string;
  submitted_at: string | null;
  commit_id: string;
  user: { login: string } | null;
  body: string | null;
}

/**
 * Build a minimal fake Octokit that implements only octokit.paginate.
 * paginate is called with octokit.rest.pulls.listReviews as the first arg;
 * the stub ignores the endpoint reference and returns the provided pages.
 */
function buildFakeOctokit(pages: FakeReviewData[][]): Octokit {
  // Flatten pages to simulate paginate collecting all pages into one array.
  const allItems = pages.flat();

  const paginateMock = mock(async (_endpoint: unknown, _options: unknown) => allItems);

  return {
    paginate: paginateMock,
    rest: {
      pulls: {
        // listReviews itself is never called directly (paginate wraps it),
        // but we include a stub so the type resolves.
        listReviews: mock(async () => ({ data: [] })),
      },
    },
  } as unknown as Octokit;
}

/**
 * Build a review fixture with sensible defaults. Override specific fields.
 */
function makeRawReview(overrides: Partial<FakeReviewData> = {}): FakeReviewData {
  return {
    id: 1,
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-04-01T10:00:00Z",
    commit_id: "abc123",
    user: { login: MINSKY_REVIEWER_BOT_LOGIN },
    body: `**${CHINESE_WALL_MARKER} (Chinese-wall)**\n\n### Findings\n\n- **[BLOCKING]** src/foo.ts:1`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fetchPriorReviews tests
// ---------------------------------------------------------------------------

describe("fetchPriorReviews", () => {
  test("calls octokit.paginate (not listReviews directly) to follow Link headers", async () => {
    const octokit = buildFakeOctokit([[makeRawReview()]]);
    await fetchPriorReviews(octokit, "owner", "repo", 1);

    // paginate must be called exactly once
    expect((octokit.paginate as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    // listReviews itself should NOT be called directly
    expect((octokit.rest.pulls.listReviews as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("returns bot reviews that contain the Chinese-wall marker", async () => {
    const review = makeRawReview();
    const octokit = buildFakeOctokit([[review]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.userLogin).toBe(MINSKY_REVIEWER_BOT_LOGIN);
    expect(results[0]?.body).toContain(CHINESE_WALL_MARKER);
  });

  test("excludes DISMISSED reviews", async () => {
    const dismissed = makeRawReview({ state: "DISMISSED" });
    const accepted = makeRawReview({ id: 2, state: "CHANGES_REQUESTED" });
    const octokit = buildFakeOctokit([[dismissed, accepted]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(2);
  });

  test("excludes PENDING reviews", async () => {
    const pending = makeRawReview({ state: "PENDING" });
    const octokit = buildFakeOctokit([[pending]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(0);
  });

  test("excludes non-allowlisted bot logins (dependabot, unknown bots)", async () => {
    const dependabot = makeRawReview({
      id: 1,
      user: { login: "dependabot[bot]" },
      body: "Bumped lodash",
    });
    const unknownBot = makeRawReview({
      id: 2,
      user: { login: "some-other-bot[bot]" },
      body: `**${CHINESE_WALL_MARKER}** — spoofed`,
    });
    const octokit = buildFakeOctokit([[dependabot, unknownBot]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(0);
  });

  test("excludes empty-output skip-notices from minsky-reviewer[bot] (no Chinese-wall marker)", async () => {
    // buildEmptyOutputSkipNotice bodies start with "⚠️ **Automated review skipped**"
    // and intentionally lack the Chinese-wall marker.
    const skipNotice = makeRawReview({
      state: "COMMENTED",
      body:
        `⚠️ **Automated review skipped** — the reviewer (openai:gpt-5) ` +
        `returned no content for this PR.\n\n` +
        `This is **not** an approval or a rejection. Manual review is recommended.`,
    });
    const octokit = buildFakeOctokit([[skipNotice]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(0);
  });

  test("excludes CoT leakage notices from minsky-reviewer[bot] (no Chinese-wall marker)", async () => {
    // sanitize.ts CoT leakage notices start with "**reviewer-service error:**"
    // and also lack the Chinese-wall marker.
    const leakageNotice = makeRawReview({
      state: "COMMENTED",
      body:
        "**reviewer-service error: chain-of-thought leakage detected**\n\n" +
        "The model's raw reasoning leaked into the review body.",
    });
    const octokit = buildFakeOctokit([[leakageNotice]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(0);
  });

  test("handles null body (coerces to empty string, excluded because no marker)", async () => {
    const nullBodyReview = makeRawReview({ body: null });
    const octokit = buildFakeOctokit([[nullBodyReview]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    // null body → no CHINESE_WALL_MARKER → excluded
    expect(results).toHaveLength(0);
  });

  test("handles null user (coerces login to empty string, excluded from allowlist)", async () => {
    const nullUserReview = makeRawReview({ user: null });
    const octokit = buildFakeOctokit([[nullUserReview]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    // "" is not in ALLOWED_REVIEWER_BOT_LOGINS → excluded
    expect(results).toHaveLength(0);
  });

  test("sorts results ascending by submittedAt (oldest first)", async () => {
    const oldest = makeRawReview({ id: 1, submitted_at: "2026-04-01T00:00:00Z" });
    const newest = makeRawReview({ id: 2, submitted_at: "2026-04-03T00:00:00Z" });
    const middle = makeRawReview({ id: 3, submitted_at: "2026-04-02T00:00:00Z" });

    // Provide out-of-order from paginate to verify sorting
    const octokit = buildFakeOctokit([[newest, oldest, middle]]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    expect(results).toHaveLength(3);
    expect(results[0]?.id).toBe(1); // oldest
    expect(results[1]?.id).toBe(3); // middle
    expect(results[2]?.id).toBe(2); // newest
  });

  test("handles multiple pages (paginate flattens them)", async () => {
    const page1 = [
      makeRawReview({ id: 1, submitted_at: "2026-04-01T00:00:00Z" }),
      makeRawReview({ id: 2, submitted_at: "2026-04-02T00:00:00Z" }),
    ];
    const page2 = [makeRawReview({ id: 3, submitted_at: "2026-04-03T00:00:00Z" })];

    const octokit = buildFakeOctokit([page1, page2]);
    const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

    // All 3 reviews from both pages are present
    expect(results).toHaveLength(3);
    // Sorted oldest-first
    expect(results[0]?.id).toBe(1);
    expect(results[2]?.id).toBe(3);
  });

  test("warns and truncates when more than 500 reviews are returned", async () => {
    // Create 501 reviews all with the bot marker
    const manyReviews = Array.from({ length: 501 }, (_, i) =>
      makeRawReview({
        id: i + 1,
        submitted_at: `2026-01-${String(Math.floor(i / 24) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
      })
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const octokit = buildFakeOctokit([manyReviews]);

    try {
      const results = await fetchPriorReviews(octokit, "owner", "repo", 1);

      // Truncated to MAX_REVIEWS_FETCHED (500)
      expect(results.length).toBeLessThanOrEqual(500);
      // Warning was emitted
      expect(warnSpy).toHaveBeenCalled();
      const warnMessage = warnSpy.mock.calls[0]?.[0] as string;
      expect(warnMessage).toContain("501");
      expect(warnMessage).toContain("500");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
