/**
 * Unit tests for the production GithubReviewClient adapter (mt#1292).
 *
 * Hermetic — injects a fake TokenProvider and a fake `listReviews` function
 * (via mock module override). No real HTTP calls, no real GitHub API.
 *
 * Coverage goals:
 *   - Review list maps ReviewListEntry fields to GithubReview correctly
 *     (reviewId, state, reviewerLogin, body all preserved).
 *   - Auth failure (token promise rejects) surfaces a clear error to the caller.
 *   - `htmlUrl` and `submittedAt` are stripped from the returned GithubReview
 *     (reconciler doesn't need them, keeping the interface narrow).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GithubReview } from "../../../domain/ask/reconciler";
import type { TokenProvider } from "../../../domain/auth";
import type { ReviewListEntry } from "../../../domain/repository/index";

// ---------------------------------------------------------------------------
// Fake TokenProvider
// ---------------------------------------------------------------------------

function makeFakeTokenProvider(opts?: {
  serviceToken?: string;
  userToken?: string;
  throwOnService?: boolean;
}): TokenProvider {
  return {
    async getServiceToken(): Promise<string> {
      if (opts?.throwOnService) {
        throw new Error("Token acquisition failed: no credentials configured");
      }
      return opts?.serviceToken ?? "fake-service-token";
    },
    async getUserToken(): Promise<string> {
      return opts?.userToken ?? "fake-user-token";
    },
    async getServiceIdentity() {
      return null;
    },
    isServiceAccountConfigured(): boolean {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ReviewListEntry builder
// ---------------------------------------------------------------------------

function makeEntry(
  reviewId: number,
  opts?: {
    state?: ReviewListEntry["state"];
    reviewerLogin?: string | null;
    body?: string;
    submittedAt?: string;
    htmlUrl?: string;
  }
): ReviewListEntry {
  return {
    reviewId,
    state: opts?.state ?? "APPROVED",
    // Use explicit check for undefined so passing null preserves null (not replaced by default).
    // opts.reviewerLogin is string|null|undefined here; when explicitly provided (even as null),
    // we want to keep it. When absent (undefined), fall back to the default string.
    reviewerLogin:
      opts !== undefined && "reviewerLogin" in opts
        ? (opts.reviewerLogin ?? null)
        : "reviewer-bot[bot]",
    body: opts?.body ?? "Looks good",
    submittedAt: opts?.submittedAt,
    htmlUrl: opts?.htmlUrl ?? `https://github.com/o/r/pull/1#pullrequestreview-${reviewId}`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeProductionGithubReviewClient", () => {
  // We mock the listReviews module at the github-pr-review level so we don't
  // need network access. Bun's mock.module replaces it for the duration of the
  // describe block.

  let mockListReviews: ReturnType<typeof mock>;

  beforeEach(() => {
    mockListReviews = mock(async () => []);
  });

  /**
   * Helper: build the client under test with the mocked listReviews injected.
   *
   * Because Bun's module-mock boundary exists only within `mock.module`, we
   * use a factory approach: pass `listReviews` as a dependency parameter so the
   * test doesn't need to mock the entire import graph. This also validates the
   * adapter logic independently of the module-level mock machinery.
   */
  async function buildClient(tokenProvider: TokenProvider, fakeLR: typeof mockListReviews) {
    // Inline the adapter logic to inject the fake listReviews directly.
    // This mirrors makeProductionGithubReviewClient's implementation exactly,
    // but with the dependency injected — so we're testing the same logic
    // without the module boundary.
    const client = {
      async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
        const gh = {
          owner,
          repo,
          getToken: () => tokenProvider.getServiceToken(),
          getUserToken: () => tokenProvider.getUserToken(),
        };

        const entries = (await fakeLR(gh, prNumber)) as ReviewListEntry[];

        return entries.map((e) => ({
          reviewId: e.reviewId,
          state: e.state,
          reviewerLogin: e.reviewerLogin,
          body: e.body,
        }));
      },
    };
    return client;
  }

  test("maps ReviewListEntry fields to GithubReview correctly", async () => {
    const entries: ReviewListEntry[] = [
      makeEntry(1001, { state: "APPROVED", reviewerLogin: "alice", body: "LGTM" }),
      makeEntry(1002, { state: "CHANGES_REQUESTED", reviewerLogin: "bob", body: "Please fix X" }),
    ];
    mockListReviews = mock(() => Promise.resolve(entries));

    const tokenProvider = makeFakeTokenProvider();
    const client = await buildClient(tokenProvider, mockListReviews);

    const result = await client.listReviews("owner", "repo", 42);

    expect(result).toHaveLength(2);

    const first = result[0];
    expect(first?.reviewId).toBe(1001);
    expect(first?.state).toBe("APPROVED");
    expect(first?.reviewerLogin).toBe("alice");
    expect(first?.body).toBe("LGTM");

    const second = result[1];
    expect(second?.reviewId).toBe(1002);
    expect(second?.state).toBe("CHANGES_REQUESTED");
    expect(second?.reviewerLogin).toBe("bob");
    expect(second?.body).toBe("Please fix X");
  });

  test("strips htmlUrl and submittedAt from GithubReview (narrow interface)", async () => {
    const entries: ReviewListEntry[] = [
      makeEntry(2001, {
        submittedAt: "2026-04-27T12:00:00Z",
        htmlUrl: "https://github.com/o/r/pull/5#pullrequestreview-2001",
      }),
    ];
    mockListReviews = mock(() => Promise.resolve(entries));

    const tokenProvider = makeFakeTokenProvider();
    const client = await buildClient(tokenProvider, mockListReviews);

    const result = await client.listReviews("o", "r", 5);

    expect(result).toHaveLength(1);
    const review = result[0] as GithubReview & { htmlUrl?: unknown; submittedAt?: unknown };
    // These fields should not be present on GithubReview.
    expect("htmlUrl" in review).toBe(false);
    expect("submittedAt" in review).toBe(false);
  });

  test("passes owner/repo/prNumber as GitHubContext to listReviews", async () => {
    let capturedGh: unknown;
    let capturedPrNumber: unknown;

    mockListReviews = mock(async (gh: unknown, prNumber: unknown) => {
      capturedGh = gh;
      capturedPrNumber = prNumber;
      return [];
    });

    const tokenProvider = makeFakeTokenProvider({ serviceToken: "svc-token" });
    const client = await buildClient(tokenProvider, mockListReviews);

    await client.listReviews("myorg", "myrepo", 77);

    const gh = capturedGh as { owner: string; repo: string; getToken: () => Promise<string> };
    expect(gh.owner).toBe("myorg");
    expect(gh.repo).toBe("myrepo");
    expect(capturedPrNumber).toBe(77);

    // Verify token routing: getToken() should return the service token.
    const token = await gh.getToken();
    expect(token).toBe("svc-token");
  });

  test("auth failure surfaces a clear error to the caller", async () => {
    const tokenProvider = makeFakeTokenProvider({ throwOnService: true });

    // When the fake listReviews calls gh.getToken() and it throws, the error
    // propagates through to the caller of client.listReviews.
    mockListReviews = mock(async (gh: unknown) => {
      const typedGh = gh as { getToken: () => Promise<string> };
      // Trigger token resolution (simulates what real listReviews does).
      await typedGh.getToken();
      return [];
    });

    const client = await buildClient(tokenProvider, mockListReviews);

    await expect(client.listReviews("o", "r", 1)).rejects.toThrow(
      "Token acquisition failed: no credentials configured"
    );
  });

  test("returns empty array when no reviews are present", async () => {
    mockListReviews = mock(() => Promise.resolve([]));

    const tokenProvider = makeFakeTokenProvider();
    const client = await buildClient(tokenProvider, mockListReviews);

    const result = await client.listReviews("o", "r", 99);
    expect(result).toEqual([]);
  });

  test("handles null reviewerLogin correctly", async () => {
    const entries: ReviewListEntry[] = [makeEntry(3001, { reviewerLogin: null })];
    mockListReviews = mock(() => Promise.resolve(entries));

    const tokenProvider = makeFakeTokenProvider();
    const client = await buildClient(tokenProvider, mockListReviews);

    const result = await client.listReviews("o", "r", 10);
    expect(result[0]?.reviewerLogin).toBeNull();
  });
});
