/**
 * Unit tests for the production GithubReviewClient adapter (mt#1292).
 *
 * Hermetic — injects a fake TokenProvider and a fake `listReviews` function
 * via the optional `listReviewsImpl` parameter of `makeProductionGithubReviewClient`.
 * No real HTTP calls, no real GitHub API. The production module is imported and
 * exercised directly.
 *
 * Coverage:
 *   - Review list maps ReviewListEntry fields to GithubReview correctly
 *     (reviewId, state, reviewerLogin, body all preserved).
 *   - Empty list pass-through.
 *   - Null reviewerLogin pass-through.
 *   - Auth failure (token promise rejects) surfaces the original error.
 *   - `getToken` is called with `${owner}/${repo}` scope for least-privilege.
 *   - `htmlUrl` and `submittedAt` are stripped from the returned GithubReview.
 */

import { describe, test, expect } from "bun:test";
import { makeProductionGithubReviewClient } from "./asks-github-client";
import type { GithubReview } from "../../../domain/ask/reconciler";
import type { TokenProvider } from "../../../domain/auth";
import type { ReviewListEntry } from "../../../domain/repository/index";
import type { GitHubContext } from "../../../domain/repository/github-pr-operations";

// ---------------------------------------------------------------------------
// Type alias matching ListReviewsFn (mirrors the private type in the module)
// ---------------------------------------------------------------------------

type ListReviewsFn = (
  gh: GitHubContext,
  prIdentifier: string | number
) => Promise<ReviewListEntry[]>;

// ---------------------------------------------------------------------------
// Fake TokenProvider
// ---------------------------------------------------------------------------

function makeFakeTokenProvider(opts?: {
  serviceToken?: string;
  throwOnService?: boolean;
  onGetServiceToken?: (repo?: string) => void;
}): TokenProvider {
  return {
    async getServiceToken(repo?: string): Promise<string> {
      opts?.onGetServiceToken?.(repo);
      if (opts?.throwOnService) {
        throw new Error("Token acquisition failed: no credentials configured");
      }
      return opts?.serviceToken ?? "fake-service-token";
    },
    async getUserToken(): Promise<string> {
      return "fake-user-token";
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
  test("maps ReviewListEntry fields to GithubReview correctly", async () => {
    const entries: ReviewListEntry[] = [
      makeEntry(1001, { state: "APPROVED", reviewerLogin: "alice", body: "LGTM" }),
      makeEntry(1002, { state: "CHANGES_REQUESTED", reviewerLogin: "bob", body: "Please fix X" }),
    ];

    const fakeListReviews: ListReviewsFn = async (_gh, _prNumber) => entries;

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

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

    const fakeListReviews: ListReviewsFn = async (_gh, _prNumber) => entries;

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

    const result = await client.listReviews("o", "r", 5);

    expect(result).toHaveLength(1);
    const review = result[0] as GithubReview & { htmlUrl?: unknown; submittedAt?: unknown };
    // These fields should not be present on GithubReview.
    expect("htmlUrl" in review).toBe(false);
    expect("submittedAt" in review).toBe(false);
  });

  test("passes owner/repo/prNumber as GitHubContext to listReviews", async () => {
    let capturedGh: GitHubContext | undefined;
    let capturedPrNumber: string | number | undefined;

    const fakeListReviews: ListReviewsFn = async (gh, prNumber) => {
      capturedGh = gh;
      capturedPrNumber = prNumber;
      return [];
    };

    const tokenProvider = makeFakeTokenProvider({ serviceToken: "svc-token" });
    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

    await client.listReviews("myorg", "myrepo", 77);

    expect(capturedGh?.owner).toBe("myorg");
    expect(capturedGh?.repo).toBe("myrepo");
    expect(capturedPrNumber).toBe(77);
  });

  test("calls getServiceToken with owner/repo scope", async () => {
    let capturedScope: string | undefined;

    const tokenProvider = makeFakeTokenProvider({
      onGetServiceToken: (repo) => {
        capturedScope = repo;
      },
    });

    // Simulate what real listReviews does: it resolves the token via gh.getToken().
    const fakeListReviews: ListReviewsFn = async (gh, _prNumber) => {
      await gh.getToken();
      return [];
    };

    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);
    await client.listReviews("myorg", "myrepo", 5);

    // Token must be scoped to the repository for least-privilege.
    expect(capturedScope).toBe("myorg/myrepo");
  });

  test("auth failure surfaces the original error to the caller", async () => {
    const tokenProvider = makeFakeTokenProvider({ throwOnService: true });

    // Simulate what real listReviews does: it resolves the token via gh.getToken().
    const fakeListReviews: ListReviewsFn = async (gh, _prNumber) => {
      await gh.getToken();
      return [];
    };

    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

    await expect(client.listReviews("o", "r", 1)).rejects.toThrow(
      "Token acquisition failed: no credentials configured"
    );
  });

  test("returns empty array when no reviews are present", async () => {
    const fakeListReviews: ListReviewsFn = async (_gh, _prNumber) => [];

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

    const result = await client.listReviews("o", "r", 99);
    expect(result).toEqual([]);
  });

  test("handles null reviewerLogin correctly", async () => {
    const entries: ReviewListEntry[] = [makeEntry(3001, { reviewerLogin: null })];

    const fakeListReviews: ListReviewsFn = async (_gh, _prNumber) => entries;

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionGithubReviewClient(tokenProvider, fakeListReviews);

    const result = await client.listReviews("o", "r", 10);
    expect(result[0]?.reviewerLogin).toBeNull();
  });
});
