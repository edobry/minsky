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

import { describe, test, expect, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { ReviewerConfig } from "./config";
import { CHINESE_WALL_MARKER, MINSKY_REVIEWER_BOT_LOGIN } from "./prior-review-summary";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";
import {
  createOctokit,
  fetchPriorReviews,
  fetchListFiles,
  MAX_FILES_FETCHED,
  fetchReviewThreads,
  resolveThread,
  submitReview,
} from "./github-client";

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
    expect((octokit.paginate as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    // listReviews itself should NOT be called directly
    expect(
      (octokit.rest.pulls.listReviews as unknown as ReturnType<typeof mock>).mock.calls
    ).toHaveLength(0);
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

    const octokit = buildFakeOctokit([manyReviews]);

    const { logs, restore } = captureConsoleLogs();
    let results: Awaited<ReturnType<typeof fetchPriorReviews>>;
    try {
      results = await fetchPriorReviews(octokit, "owner", "repo", 1);
    } finally {
      restore();
    }

    // Truncated to MAX_REVIEWS_FETCHED (500)
    expect(results.length).toBeLessThanOrEqual(500);

    const capLog = findLogEvent(logs, "reviewer.prior_reviews_cap_exceeded");
    expect(capLog).not.toBeNull();
    expect(capLog?.pr).toBe(1);
    expect(capLog?.count).toBe(501);
    expect(capLog?.cap).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// fetchListFiles tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Octokit for fetchListFiles tests.
 * fetchListFiles calls octokit.paginate(octokit.rest.pulls.listFiles, ...).
 */
function buildListFilesOctokit(
  paginateImpl: (
    endpoint: unknown,
    options: unknown
  ) => Promise<
    Array<{
      filename: string;
      status?: string;
      additions?: number;
      deletions?: number;
      patch?: string;
    }>
  >
): Octokit {
  return {
    paginate: mock(paginateImpl),
    rest: {
      pulls: {
        listFiles: mock(async () => ({ data: [] })),
      },
    },
  } as unknown as Octokit;
}

describe("fetchListFiles", () => {
  test("calls octokit.paginate (not listFiles directly) to follow Link headers", async () => {
    const octokit = buildListFilesOctokit(async () => [
      { filename: "src/foo.ts", status: "modified", additions: 10, deletions: 5 },
    ]);

    await fetchListFiles(octokit, "owner", "repo", 42);

    expect((octokit.paginate as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    // listFiles itself must NOT be called directly
    expect(
      (octokit.rest.pulls.listFiles as unknown as ReturnType<typeof mock>).mock.calls
    ).toHaveLength(0);
  });

  test("returns file entries with patch data on success", async () => {
    const octokit = buildListFilesOctokit(async () => [
      {
        filename: "src/foo.ts",
        status: "modified",
        additions: 10,
        deletions: 5,
        patch: "@@ -1,5 +1,10 @@",
      },
      { filename: "src/bar.ts", status: "added", additions: 20, deletions: 0 },
      {
        filename: "README.md",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "@@ -1 +1 @@",
      },
    ]);

    const result = await fetchListFiles(octokit, "owner", "repo", 1);
    expect(result).toHaveLength(3);
    expect(result[0]?.filename).toBe("src/foo.ts");
    expect(result[0]?.patch).toBe("@@ -1,5 +1,10 @@");
    expect(result[1]?.filename).toBe("src/bar.ts");
    expect(result[1]?.patch).toBeUndefined();
    expect(result.map((f) => f.filename)).toEqual(["src/foo.ts", "src/bar.ts", "README.md"]);
  });

  test("returns [] and emits pr_scope_listfiles_error structured log on paginate error", async () => {
    const octokit = buildListFilesOctokit(async () => {
      throw new Error("API rate limit exceeded");
    });

    const { logs, restore } = captureConsoleLogs();
    let result: import("./github-client").PrFileEntry[];
    try {
      result = await fetchListFiles(octokit, "owner", "repo", 7);
    } finally {
      restore();
    }

    expect(result).toEqual([]);
    const errorLog = findLogEvent(logs, "pr_scope_listfiles_error");
    expect(errorLog).not.toBeNull();
    expect(errorLog?.pr).toBe(7);
    expect(errorLog?.error).toContain("rate limit");
  });

  test("returns [] and emits pr_scope_files_cap_exceeded when file count exceeds MAX_FILES_FETCHED", async () => {
    const tooManyFiles = Array.from({ length: MAX_FILES_FETCHED + 1 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const octokit = buildListFilesOctokit(async () => tooManyFiles);

    const { logs, restore } = captureConsoleLogs();
    let result: import("./github-client").PrFileEntry[];
    try {
      result = await fetchListFiles(octokit, "owner", "repo", 99);
    } finally {
      restore();
    }

    expect(result).toEqual([]);
    const capLog = findLogEvent(logs, "pr_scope_files_cap_exceeded");
    expect(capLog).not.toBeNull();
    expect(capLog?.pr).toBe(99);
    expect(capLog?.fileCount).toBe(MAX_FILES_FETCHED + 1);
    expect(capLog?.cap).toBe(MAX_FILES_FETCHED);
  });

  test("returns entries (not []) when file count is exactly at the cap boundary (not exceeded)", async () => {
    const exactlyAtCap = Array.from({ length: MAX_FILES_FETCHED }, (_, i) => ({
      filename: `src/file${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const octokit = buildListFilesOctokit(async () => exactlyAtCap);

    const result = await fetchListFiles(octokit, "owner", "repo", 1);
    expect(result).toHaveLength(MAX_FILES_FETCHED);
    expect(result[0]?.filename).toBe("src/file0.ts");
  });
});

// ---------------------------------------------------------------------------
// fetchReviewThreads tests (mt#1345)
// ---------------------------------------------------------------------------

/**
 * GQL response shape for a single page of review threads.
 */
interface FakeGqlPage {
  nodes: Array<{
    id: string;
    path: string;
    line: number | null;
    startLine: number | null;
    isResolved: boolean;
    isOutdated: boolean;
    isCollapsed: boolean;
    comments: {
      totalCount: number;
      nodes: Array<{
        databaseId: number;
        author: { login: string } | null;
        body: string;
        createdAt: string;
      }>;
    };
  }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function buildThreadOctokit(pages: FakeGqlPage[]): Octokit {
  let pageIndex = 0;
  const graphqlMock = mock(async (_query: string, _vars: unknown) => {
    const page = pages[pageIndex++] ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    return {
      repository: {
        pullRequest: {
          reviewThreads: page,
        },
      },
    };
  });
  return { graphql: graphqlMock } as unknown as Octokit;
}

function makeThread(overrides: Partial<FakeGqlPage["nodes"][0]> = {}): FakeGqlPage["nodes"][0] {
  return {
    id: "PRRT_kwDOX1",
    path: "src/foo.ts",
    line: 42,
    startLine: null,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    comments: {
      totalCount: 1,
      nodes: [
        {
          databaseId: 100001,
          author: { login: "minsky-reviewer[bot]" },
          body: "Still a concern.",
          createdAt: "2026-05-01T00:00:00Z",
        },
      ],
    },
    ...overrides,
  };
}

describe("fetchReviewThreads", () => {
  test("single page: threads mapped correctly including databaseId", async () => {
    const octokit = buildThreadOctokit([
      {
        nodes: [
          makeThread({ id: "T_1", path: "src/a.ts", line: 10 }),
          makeThread({ id: "T_2", path: "src/b.ts", line: 20, isResolved: true }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("T_1");
    expect(result[0]?.path).toBe("src/a.ts");
    expect(result[0]?.line).toBe(10);
    expect(result[0]?.isResolved).toBe(false);
    expect(result[0]?.comments[0]?.databaseId).toBe(100001);
    expect(result[1]?.isResolved).toBe(true);
  });

  test("null author maps to null in comments", async () => {
    const octokit = buildThreadOctokit([
      {
        nodes: [
          makeThread({
            id: "T_null_author",
            comments: {
              totalCount: 1,
              nodes: [
                {
                  databaseId: 99999,
                  author: null,
                  body: "Bot deleted",
                  createdAt: "2026-05-01T00:00:00Z",
                },
              ],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result[0]?.comments[0]?.author).toBeNull();
  });

  test("truncatedComments: true when totalCount > comments.nodes.length", async () => {
    const octokit = buildThreadOctokit([
      {
        nodes: [
          makeThread({
            comments: {
              totalCount: 15, // more than the 1 node we return
              nodes: [
                {
                  databaseId: 111,
                  author: { login: "alice" },
                  body: "First comment",
                  createdAt: "2026-05-01T00:00:00Z",
                },
              ],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result[0]?.truncatedComments).toBe(true);
  });

  test("truncatedComments: false when totalCount equals comments.nodes.length", async () => {
    const octokit = buildThreadOctokit([
      {
        nodes: [makeThread()], // totalCount:1, nodes.length:1
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result[0]?.truncatedComments).toBe(false);
  });

  test("pagination: calls graphql twice when hasNextPage=true on first page", async () => {
    const octokit = buildThreadOctokit([
      {
        nodes: [makeThread({ id: "T_page1" })],
        pageInfo: { hasNextPage: true, endCursor: "cursor1" },
      },
      {
        nodes: [makeThread({ id: "T_page2" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("T_page1");
    expect(result[1]?.id).toBe("T_page2");
    // graphql was called twice
    expect((octokit.graphql as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test("empty PR: returns empty array when pullRequest has no threads", async () => {
    const octokit = buildThreadOctokit([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result).toEqual([]);
  });

  test("returns [] and emits reviewer_fetch_threads_error on GraphQL error", async () => {
    const graphqlMock = mock(async () => {
      throw new Error("GraphQL rate limit exceeded");
    });
    const octokit = { graphql: graphqlMock } as unknown as Octokit;

    const { logs, restore } = captureConsoleLogs();
    let result: Awaited<ReturnType<typeof fetchReviewThreads>>;
    try {
      result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    } finally {
      restore();
    }

    expect(result).toEqual([]);
    const errorLog = findLogEvent(logs, "reviewer_fetch_threads_error");
    expect(errorLog).not.toBeNull();
    expect(errorLog?.pr).toBe(42);
  });

  test("returns [] when repository.pullRequest is null (permissions / not found)", async () => {
    const graphqlMock = mock(async () => ({
      repository: { pullRequest: null },
    }));
    const octokit = { graphql: graphqlMock } as unknown as Octokit;

    const result = await fetchReviewThreads(octokit, "owner", "repo", 42);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveThread tests (mt#1345)
// ---------------------------------------------------------------------------

describe("resolveThread", () => {
  test("calls octokit.graphql with the mutation and threadId", async () => {
    const graphqlMock = mock(async (_query: string, vars: unknown) => ({
      resolveReviewThread: { thread: { id: "PRRT_kwDOX1", isResolved: true } },
    }));
    const octokit = { graphql: graphqlMock } as unknown as Octokit;

    await resolveThread(octokit, "PRRT_kwDOX1");

    expect(graphqlMock.mock.calls).toHaveLength(1);
    const [_query, vars] = graphqlMock.mock.calls[0] as [string, { threadId: string }];
    expect(vars.threadId).toBe("PRRT_kwDOX1");
  });

  test("throws when graphql mutation returns an error", async () => {
    const graphqlMock = mock(async () => {
      throw new Error("Not authorized to resolve thread");
    });
    const octokit = { graphql: graphqlMock } as unknown as Octokit;

    await expect(resolveThread(octokit, "PRRT_kwDOX1")).rejects.toThrow("Not authorized");
  });
});

// ---------------------------------------------------------------------------
// submitReview tests (PR #1069 R1 BLOCKING #2 — Octokit payload shape)
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Octokit that exposes only `rest.pulls.createReview`
 * as a mock. The mock returns the response shape `submitReview` reads
 * (`{ data: { id, html_url } }`). Tests inspect the call args.
 */
function buildFakeCreateReviewOctokit() {
  const createReviewMock = mock(
    async (_args: unknown): Promise<{ data: { id: number; html_url: string } }> => ({
      data: { id: 999, html_url: "https://example/pr/1#pullrequestreview-999" },
    })
  );
  const octokit = {
    rest: {
      pulls: {
        createReview: createReviewMock,
      },
    },
  } as unknown as Octokit;
  return { octokit, createReviewMock };
}

describe("submitReview", () => {
  // Guard message used when narrowing `args.comments` after asserting it's defined.
  // Tests assert `expect(comments).toBeDefined()` before this throw — the throw is
  // a TypeScript-narrowing convenience, not an expected runtime path in passing tests.
  const COMMENTS_MISSING = "comments missing";

  test("top-level inline comment payload includes side='RIGHT' default + path + line + body, no in_reply_to", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "COMMENT", "body", undefined, [
      { path: "src/foo.ts", line: 42, body: "issue here" },
    ]);

    expect(createReviewMock.mock.calls).toHaveLength(1);
    const args = createReviewMock.mock.calls[0]?.[0] as {
      comments?: Array<Record<string, unknown>>;
    };
    const comments = args.comments;
    expect(comments).toBeDefined();
    expect(comments).toHaveLength(1);
    if (!comments) throw new Error(COMMENTS_MISSING);
    const c = comments[0];
    expect(c).toEqual({
      path: "src/foo.ts",
      line: 42,
      side: "RIGHT",
      body: "issue here",
    });
  });

  test("top-level inline comment honors explicit side='LEFT'", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "COMMENT", "body", undefined, [
      { path: "src/foo.ts", line: 42, side: "LEFT", body: "issue here" },
    ]);

    const args = createReviewMock.mock.calls[0]?.[0] as {
      comments?: Array<Record<string, unknown>>;
    };
    const comments = args.comments;
    if (!comments) throw new Error(COMMENTS_MISSING);
    expect(comments[0]).toEqual({
      path: "src/foo.ts",
      line: 42,
      side: "LEFT",
      body: "issue here",
    });
  });

  test("reply comment (inReplyTo set) payload contains only body + in_reply_to, no path/line/side", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "COMMENT", "body", undefined, [
      { path: "src/foo.ts", line: 42, body: "still applies", inReplyTo: 12345 },
    ]);

    const args = createReviewMock.mock.calls[0]?.[0] as {
      comments?: Array<Record<string, unknown>>;
    };
    const comments = args.comments;
    if (!comments) throw new Error(COMMENTS_MISSING);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      body: "still applies",
      in_reply_to: 12345,
    });
  });

  test("mixed array produces both top-level and reply shapes correctly", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "REQUEST_CHANGES", "body", undefined, [
      { path: "a.ts", line: 1, body: "new finding" },
      { path: "b.ts", line: 2, body: "reply", inReplyTo: 555 },
      { path: "c.ts", line: 3, body: "another new finding", side: "LEFT" },
    ]);

    const args = createReviewMock.mock.calls[0]?.[0] as {
      comments?: Array<Record<string, unknown>>;
    };
    const comments = args.comments;
    if (!comments) throw new Error(COMMENTS_MISSING);
    expect(comments).toHaveLength(3);

    // First: top-level, default side
    expect(comments[0]).toEqual({
      path: "a.ts",
      line: 1,
      side: "RIGHT",
      body: "new finding",
    });

    // Second: reply, only body + in_reply_to
    expect(comments[1]).toEqual({
      body: "reply",
      in_reply_to: 555,
    });

    // Third: top-level, explicit LEFT side
    expect(comments[2]).toEqual({
      path: "c.ts",
      line: 3,
      side: "LEFT",
      body: "another new finding",
    });
  });

  test("empty inline comments array → no comments field in Octokit payload", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "APPROVE", "body", undefined, []);

    const args = createReviewMock.mock.calls[0]?.[0] as { comments?: unknown };
    expect(args.comments).toBeUndefined();
  });

  test("undefined inline comments → no comments field in Octokit payload", async () => {
    const { octokit, createReviewMock } = buildFakeCreateReviewOctokit();

    await submitReview(octokit, "owner", "repo", 1, "APPROVE", "body");

    const args = createReviewMock.mock.calls[0]?.[0] as { comments?: unknown };
    expect(args.comments).toBeUndefined();
  });
});

// ── createOctokit (mt#2717) ──────────────────────────────────────────────────

/**
 * Minimal ReviewerConfig for createOctokit — only appId/privateKey/installationId
 * are read; the remaining fields are filler to satisfy the type.
 */
function testConfig(privateKey: string): ReviewerConfig {
  return {
    appId: 12345,
    privateKey,
    installationId: 67890,
    webhookSecret: "test-secret",
    provider: "openai",
    providerApiKey: "test-key",
    providerModel: "gpt-5",
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 3000,
    logLevel: "info",
    modelTimeoutMs: 120_000,
    githubTimeoutMs: 30_000,
  };
}

describe("createOctokit (mt#2717)", () => {
  test("defers auth to request time (no eager mint/sign at construction)", async () => {
    // The pre-mt#2717 body signed a JWT and minted an installation token AT
    // CONSTRUCTION (`const { token } = await auth({ type: "installation" })`),
    // so a malformed private key threw here. The authStrategy form defers all
    // auth to the first request, so construction must succeed regardless of key
    // validity — the property that makes the reused, self-refreshing client
    // correct (it never re-extracts a stale token).
    const octokit = await createOctokit(testConfig("not-a-real-private-key"));
    expect(typeof octokit.request).toBe("function");
  });

  test("installs the refreshing App auth strategy (produces an App JWT locally)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const octokit = await createOctokit(testConfig(privateKey));

    // With authStrategy: createAppAuth, requesting an APP-level JWT is a purely
    // LOCAL RS256 signing operation (no network) — only possible when the
    // app-auth strategy is installed. A static-token Octokit could not satisfy
    // `{ type: "app" }`.
    const appAuth = (await octokit.auth({ type: "app" })) as { type: string; token: string };
    expect(appAuth.type).toBe("app");
    // A JWT is three dot-separated base64url segments.
    expect(appAuth.token.split(".")).toHaveLength(3);
  });
});
