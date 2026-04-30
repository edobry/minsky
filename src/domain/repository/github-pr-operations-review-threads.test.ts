/**
 * Unit tests for getPRReviewThreads (mt#1343).
 *
 * Covers:
 *  - Single-page response: threads populated correctly from GraphQL shape.
 *  - Pagination: > 50 threads page through hasNextPage cursor.
 *  - Truncation: > 200 threads capped, truncated: true.
 *  - Outdated thread: isOutdated true with line null.
 *  - Empty PR: returns { threads: [], truncated: false }.
 *
 * Tests inject a mock Octokit via the octokitOverride parameter on
 * getPRReviewThreads. The project's no-global-module-mocks rule forbids
 * mock.module(); DI is the canonical seam.
 */

import { describe, expect, test, mock } from "bun:test";
import { getPRReviewThreads, type ReviewThread } from "./github-pr-operations";

const TEST_OWNER = "test-owner";
const TEST_REPO = "test-repo";
const TEST_PR = 42;

interface GraphQLNode {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  comments: { nodes: Array<{ author: { login: string } | null; body: string; createdAt: string }> };
}

function mkNode(overrides: Partial<GraphQLNode> = {}): GraphQLNode {
  return {
    id: "T_kwDOX1",
    path: "src/foo.ts",
    line: 42,
    startLine: null,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    comments: {
      nodes: [
        {
          author: { login: "alice" },
          body: "Looks suspicious",
          createdAt: "2026-04-30T00:00:00Z",
        },
      ],
    },
    ...overrides,
  };
}

interface GraphQLPage {
  nodes: GraphQLNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function buildMockOctokit(pages: GraphQLPage[]): {
  graphql: ReturnType<typeof mock>;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let pageIndex = 0;
  return {
    graphql: mock(async (_query: string, vars: Record<string, unknown>) => {
      calls.push(vars);
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
    }),
    calls,
  };
}

const gh = {
  owner: TEST_OWNER,
  repo: TEST_REPO,
  getToken: async () => "test-token",
};

describe("getPRReviewThreads", () => {
  test("single-page response: threads mapped correctly", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [
          mkNode({ id: "T_1", path: "src/a.ts", line: 10 }),
          mkNode({ id: "T_2", path: "src/b.ts", line: 20, isResolved: true }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.threads[0]?.id).toBe("T_1");
    expect(result.threads[0]?.path).toBe("src/a.ts");
    expect(result.threads[0]?.line).toBe(10);
    expect(result.threads[0]?.isResolved).toBe(false);
    expect(result.threads[1]?.isResolved).toBe(true);
    expect(mockOctokit.calls).toHaveLength(1);
  });

  test("comment fields mapped correctly (author, body, createdAt)", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [
          mkNode({
            comments: {
              nodes: [
                {
                  author: { login: "reviewer" },
                  body: "Test comment",
                  createdAt: "2026-04-30T12:00:00Z",
                },
                {
                  author: null,
                  body: "Anonymous reply",
                  createdAt: "2026-04-30T13:00:00Z",
                },
              ],
            },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads[0]?.comments).toHaveLength(2);
    expect(result.threads[0]?.comments[0]?.author).toBe("reviewer");
    expect(result.threads[0]?.comments[0]?.body).toBe("Test comment");
    expect(result.threads[0]?.comments[0]?.createdAt).toBe("2026-04-30T12:00:00Z");
    expect(result.threads[0]?.comments[1]?.author).toBeNull();
  });

  test("outdated thread: isOutdated true, line null", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [
          mkNode({
            id: "T_outdated",
            line: null,
            isOutdated: true,
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.line).toBeNull();
    expect(result.threads[0]?.isOutdated).toBe(true);
  });

  test("multi-line range: startLine populated when set", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [mkNode({ id: "T_range", line: 50, startLine: 45 })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads[0]?.startLine).toBe(45);
    expect(result.threads[0]?.line).toBe(50);
  });

  test("startLine field absent on result when GraphQL returns null", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [mkNode({ startLine: null })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    // Single-line threads should not have startLine in the result object.
    expect("startLine" in (result.threads[0] as object)).toBe(false);
  });

  test("pagination: > 50 threads page through with cursor", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      mkNode({ id: `T_${i}`, path: `src/file${i}.ts`, line: i + 1 })
    );
    const secondPage = Array.from({ length: 30 }, (_, i) =>
      mkNode({ id: `T_${50 + i}`, path: `src/file${50 + i}.ts`, line: i + 1 })
    );

    const mockOctokit = buildMockOctokit([
      {
        nodes: firstPage,
        pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
      },
      {
        nodes: secondPage,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads).toHaveLength(80);
    expect(result.truncated).toBe(false);
    expect(mockOctokit.calls).toHaveLength(2);
    // Second call should pass the cursor from the first page.
    expect(mockOctokit.calls[1]?.after).toBe("cursor-page-1");
  });

  test("truncation: > 200 threads capped at 200 with truncated true", async () => {
    // Build 5 pages of 50 = 250 total. We expect to stop at 200 with truncated=true.
    const pages: GraphQLPage[] = Array.from({ length: 5 }, (_, pageIdx) => ({
      nodes: Array.from({ length: 50 }, (_, i) => {
        const globalIdx = pageIdx * 50 + i;
        return mkNode({ id: `T_${globalIdx}` });
      }),
      pageInfo: {
        hasNextPage: pageIdx < 4,
        endCursor: pageIdx < 4 ? `cursor-${pageIdx}` : null,
      },
    }));
    const mockOctokit = buildMockOctokit(pages);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads).toHaveLength(200);
    expect(result.truncated).toBe(true);
    // Implementation fetches one extra page (page 5) to detect truncation: the
    // cap-check fires inside the next iteration of the outer loop. Pages 6+ are
    // never fetched. 5 calls is correct semantically; an optimization could
    // skip the trailing fetch when allThreads.length exactly equals MAX.
    expect(mockOctokit.calls.length).toBe(5);
  });

  test("empty PR: returns { threads: [], truncated: false }", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    expect(result.threads).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("ReviewThread shape conforms to exported interface", async () => {
    const mockOctokit = buildMockOctokit([
      {
        nodes: [mkNode({ id: "T_shape", isCollapsed: true })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const result = await getPRReviewThreads(
      gh,
      TEST_PR,
      mockOctokit as unknown as Parameters<typeof getPRReviewThreads>[2]
    );

    const thread: ReviewThread | undefined = result.threads[0];
    if (!thread) throw new Error("Expected at least one thread");
    expect(thread.id).toBe("T_shape");
    expect(thread.isCollapsed).toBe(true);
    expect(Array.isArray(thread.comments)).toBe(true);
  });
});
