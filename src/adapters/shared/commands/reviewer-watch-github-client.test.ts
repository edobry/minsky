/**
 * Hermetic tests for the production `MissedReviewClient` adapter.
 *
 * Injects a fake `TokenProvider` and a fake Octokit factory; no real HTTP, no
 * real GitHub API. The tests exercise the production module directly (no
 * module mocks), enforcing the no-global-module-mocks lint rule.
 */

import { describe, expect, test } from "bun:test";
import { makeProductionMissedReviewClient } from "./reviewer-watch-github-client";
import type { TokenProvider } from "@minsky/domain/auth";

function makeFakeTokenProvider(captureScope?: { scope?: string }): TokenProvider {
  return {
    async getToken(_role, repo) {
      if (captureScope) captureScope.scope = repo;
      return "fake-token";
    },
    async getServiceToken(repo) {
      if (captureScope) captureScope.scope = repo;
      return "fake-service-token";
    },
    async getUserToken() {
      return "fake-user-token";
    },
    async getServiceIdentity() {
      return { login: "minsky-ai[bot]", type: "app" };
    },
    isServiceAccountConfigured() {
      return true;
    },
    // Drive-by fix for broken-on-main: mt#1510 added `isRoleConfigured` to
    // `TokenProvider` but missed updating this fake. Tracking task: see PR
    // #962 description (filed alongside the surrogate-safe-truncation fix).
    isRoleConfigured() {
      return true;
    },
  };
}

interface FakePR {
  number: number;
  head: { sha: string };
  user: { login: string } | null;
  html_url: string;
  draft: boolean;
}

interface FakeReview {
  user: { login: string } | null;
  commit_id: string | null;
  state: string;
}

function makeFakeOctokitFactory(opts: {
  prs: FakePR[];
  reviewsByPr: Record<number, FakeReview[]>;
  observedTokens?: string[];
}): (token: string) => unknown {
  return (token: string) => {
    if (opts.observedTokens) opts.observedTokens.push(token);
    const fake = {
      rest: {
        pulls: {
          list: () => Promise.resolve({ data: opts.prs }),
          listReviews: ({ pull_number }: { pull_number: number }) =>
            Promise.resolve({ data: opts.reviewsByPr[pull_number] ?? [] }),
        },
      },
      paginate: async (fn: (args: unknown) => Promise<{ data: unknown[] }>, args: unknown) => {
        const result = await fn(args);
        return result.data;
      },
    };
    return fake;
  };
}

describe("makeProductionMissedReviewClient", () => {
  test("listOpenPRs maps Octokit shape into OpenPR records", async () => {
    const factory = makeFakeOctokitFactory({
      prs: [
        {
          number: 1,
          head: { sha: "sha1" },
          user: { login: "alice" },
          html_url: "https://github.com/owner/repo/pull/1",
          draft: false,
        },
        {
          number: 2,
          head: { sha: "sha2" },
          user: null, // deleted account
          html_url: "https://github.com/owner/repo/pull/2",
          draft: true,
        },
      ],
      reviewsByPr: {},
    });

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionMissedReviewClient(
      tokenProvider,
      factory as unknown as Parameters<typeof makeProductionMissedReviewClient>[1]
    );

    const result = await client.listOpenPRs("owner", "repo");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      number: 1,
      headSha: "sha1",
      authorLogin: "alice",
      htmlUrl: "https://github.com/owner/repo/pull/1",
      draft: false,
    });
    expect(result[1]?.authorLogin).toBe(""); // null user collapses to empty string
    expect(result[1]?.draft).toBe(true);
  });

  test("listReviews maps Octokit shape into PRReviewSummary records", async () => {
    const factory = makeFakeOctokitFactory({
      prs: [],
      reviewsByPr: {
        42: [
          { user: { login: "minsky-reviewer[bot]" }, commit_id: "headsha", state: "APPROVED" },
          { user: null, commit_id: "x", state: "DISMISSED" },
        ],
      },
    });

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionMissedReviewClient(
      tokenProvider,
      factory as unknown as Parameters<typeof makeProductionMissedReviewClient>[1]
    );

    const result = await client.listReviews("owner", "repo", 42);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      reviewerLogin: "minsky-reviewer[bot]",
      commitId: "headsha",
      state: "APPROVED",
    });
    expect(result[1]?.reviewerLogin).toBeNull();
  });

  test("token is requested per call with owner/repo scope", async () => {
    const captureScope: { scope?: string } = {};
    const observedTokens: string[] = [];
    const factory = makeFakeOctokitFactory({
      prs: [],
      reviewsByPr: {},
      observedTokens,
    });

    const tokenProvider = makeFakeTokenProvider(captureScope);
    const client = makeProductionMissedReviewClient(
      tokenProvider,
      factory as unknown as Parameters<typeof makeProductionMissedReviewClient>[1]
    );

    await client.listOpenPRs("acme", "tools");

    expect(captureScope.scope).toBe("acme/tools");
    expect(observedTokens).toEqual(["fake-service-token"]);
  });

  test("commit_id null on review collapses to empty string (no thrown)", async () => {
    const factory = makeFakeOctokitFactory({
      prs: [],
      reviewsByPr: {
        1: [{ user: { login: "x" }, commit_id: null, state: "PENDING" }],
      },
    });

    const tokenProvider = makeFakeTokenProvider();
    const client = makeProductionMissedReviewClient(
      tokenProvider,
      factory as unknown as Parameters<typeof makeProductionMissedReviewClient>[1]
    );

    const result = await client.listReviews("owner", "repo", 1);
    expect(result[0]?.commitId).toBe("");
  });
});
