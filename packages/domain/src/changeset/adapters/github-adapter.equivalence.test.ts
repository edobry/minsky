/**
 * Characterization / equivalence tests for GitHubChangesetAdapter (mt#2613).
 *
 * mt#2613 refactors the adapter's Octokit construction to delegate to the
 * shared `createOctokit()` factory from `repository/github-pr-operations.ts`
 * (previously the adapter built its own independent `new Octokit(...)`
 * instance). These tests pin the adapter's observable behavior for the live
 * PR-merge path — create/get/list/approve/merge — via injected fakes, so the
 * construction-path refactor can be verified as behavior-preserving.
 *
 * No network and no `mock.module()` is used (per the project's
 * `no-global-module-mocks` ESLint rule). Instead the adapter's constructor
 * `deps.octokitOverride` / `deps.repositoryBackendOverride` DI seams — added
 * by this same change, mirroring the `octokitOverride` convention already
 * used across `repository/github-pr-*.ts` — are used to inject fake
 * transports.
 */

import { describe, expect, test } from "bun:test";
import { GitHubChangesetAdapter } from "./github-adapter";
import type { RepositoryBackend } from "../../repository/index";
import type { Octokit } from "@octokit/rest";
import type { PRInfo, MergeInfo } from "../../repository/index";
import type { ApprovalInfo } from "../../repository/approval-types";

const REPO_URL = "https://github.com/edobry/minsky";

// ---------------------------------------------------------------------------
// Fake Octokit (read paths: list / get / search)
// ---------------------------------------------------------------------------

type PullsOverrides = Partial<{
  list: (...args: unknown[]) => Promise<{ data: unknown[] }>;
  get: (...args: unknown[]) => Promise<{ data: unknown }>;
  listReviews: (...args: unknown[]) => Promise<{ data: unknown[] }>;
  listCommentsForReview: (...args: unknown[]) => Promise<{ data: unknown[] }>;
  listCommits: (...args: unknown[]) => Promise<{ data: unknown[] }>;
}>;

function makeFakeOctokit(
  overrides: {
    pulls?: PullsOverrides;
    issues?: Partial<{ listComments: (...args: unknown[]) => Promise<{ data: unknown[] }> }>;
    search?: Partial<{
      issuesAndPullRequests: (...args: unknown[]) => Promise<{ data: { items: unknown[] } }>;
    }>;
  } = {}
): Octokit {
  return {
    rest: {
      repos: {
        get: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({ data: {} }),
        listReviews: async () => ({ data: [] }),
        listCommentsForReview: async () => ({ data: [] }),
        listCommits: async () => ({ data: [] }),
        ...overrides.pulls,
      },
      issues: {
        listComments: async () => ({ data: [] }),
        ...overrides.issues,
      },
      search: {
        issuesAndPullRequests: async () => ({ data: { items: [] } }),
        ...overrides.search,
      },
    },
  } as unknown as Octokit;
}

/** Canonical Octokit PR shape reused across list/get/search tests. */
const RAW_PR = {
  number: 42,
  title: "Test PR",
  body: "PR description",
  user: { login: "octocat", name: "The Octocat", email: null },
  state: "open" as const,
  draft: false,
  merged_at: null,
  base: { ref: "main", sha: "base-sha" },
  head: { ref: "feature", sha: "head-sha" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  url: "https://api.github.com/repos/edobry/minsky/pulls/42",
  html_url: "https://github.com/edobry/minsky/pull/42",
  mergeable: true,
  mergeable_state: "clean",
};

// ---------------------------------------------------------------------------
// Fake RepositoryBackend (mutation paths: create / approve / merge)
// ---------------------------------------------------------------------------

function makeFakeBackend(overrides: {
  create?: () => Promise<PRInfo>;
  merge?: () => Promise<MergeInfo>;
  approve?: () => Promise<ApprovalInfo>;
}): RepositoryBackend {
  return {
    getType: () => "github",
    clone: async () => ({ workdir: "", session: "" }),
    branch: async () => ({ workdir: "", branch: "" }),
    getStatus: async () => ({ branch: "main", ahead: 0, behind: 0, dirty: false, remotes: [] }),
    getPath: () => "",
    validate: async () => ({ valid: true, success: true }),
    push: async () => ({ success: true }),
    pull: async () => ({ success: true }),
    pr: {
      create: async (): Promise<PRInfo> =>
        (
          overrides.create ??
          (async () => ({
            number: 42,
            url: "https://github.com/edobry/minsky/pull/42",
            state: "open" as const,
          }))
        )(),
      update: async (): Promise<PRInfo> => ({
        number: 42,
        url: "https://github.com/edobry/minsky/pull/42",
        state: "open" as const,
      }),
      close: async (): Promise<PRInfo> => ({
        number: 42,
        url: "https://github.com/edobry/minsky/pull/42",
        state: "closed" as const,
      }),
      merge: async (): Promise<MergeInfo> =>
        (
          overrides.merge ??
          (async () => ({
            commitHash: "abc123def456",
            mergeDate: "2026-01-03T00:00:00Z",
            mergedBy: "octocat",
          }))
        )(),
      get: async () => ({}),
      getDiff: async () => ({
        diff: "diff --git a/x b/x",
        stats: { filesChanged: 1, insertions: 1, deletions: 0 },
      }),
    },
    ci: {
      getChecksForRef: async () => ({ checks: [], overallState: "success" }) as never,
      getChecksForPR: async () => ({ checks: [], overallState: "success" }) as never,
    },
    review: {
      approve: async (): Promise<ApprovalInfo> =>
        (
          overrides.approve ??
          (async () => ({
            reviewId: 123,
            approvedBy: "octocat",
            approvedAt: "2026-01-03T00:00:00Z",
            prNumber: 42,
          }))
        )(),
      getApprovalStatus: async () =>
        ({ isApproved: true, approvals: [], requiredApprovals: 1, canMerge: true }) as never,
    },
  } as unknown as RepositoryBackend;
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.list (equivalence, mt#2613)", () => {
  test("maps GitHub PRs to changesets via the injected Octokit — no network", async () => {
    const octokit = makeFakeOctokit({ pulls: { list: async () => ({ data: [RAW_PR] }) } });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    const changesets = await adapter.list();

    expect(changesets).toHaveLength(1);
    expect(changesets[0]).toMatchObject({
      id: "42",
      platform: "github-pr",
      title: "Test PR",
      status: "open",
      sourceBranch: "feature",
      targetBranch: "main",
    });
  });

  test("filters by author", async () => {
    const octokit = makeFakeOctokit({
      pulls: {
        list: async () => ({
          data: [RAW_PR, { ...RAW_PR, number: 43, user: { login: "someone-else" } }],
        }),
      },
    });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    const changesets = await adapter.list({ author: "octocat" });

    expect(changesets).toHaveLength(1);
    expect(changesets[0]?.id).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.get (equivalence, mt#2613)", () => {
  test("returns a full changeset for a known PR number", async () => {
    const octokit = makeFakeOctokit({ pulls: { get: async () => ({ data: RAW_PR }) } });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    const changeset = await adapter.get("42");

    expect(changeset?.id).toBe("42");
    expect(changeset?.metadata.github?.headSha).toBe("head-sha");
    expect(changeset?.metadata.github?.baseSha).toBe("base-sha");
  });

  test("returns null for a non-numeric id without calling Octokit", async () => {
    let called = false;
    const octokit = makeFakeOctokit({
      pulls: {
        get: async () => {
          called = true;
          return { data: RAW_PR };
        },
      },
    });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    expect(await adapter.get("not-a-number")).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null on a 404 from Octokit", async () => {
    const octokit = makeFakeOctokit({
      pulls: {
        get: async () => {
          const err = new Error("Not Found") as Error & { status: number };
          err.status = 404;
          throw err;
        },
      },
    });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    expect(await adapter.get("999")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.search (equivalence, mt#2613)", () => {
  test("maps matching search results to changesets", async () => {
    const octokit = makeFakeOctokit({
      search: {
        issuesAndPullRequests: async () => ({
          data: { items: [{ number: 42, pull_request: {} }] },
        }),
      },
      pulls: { get: async () => ({ data: RAW_PR }) },
    });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    const results = await adapter.search({ query: "test" });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("42");
  });

  test("skips search results that are plain issues (no pull_request field)", async () => {
    const octokit = makeFakeOctokit({
      search: {
        issuesAndPullRequests: async () => ({
          data: { items: [{ number: 99 }] }, // no `pull_request` — an issue, not a PR
        }),
      },
    });
    const adapter = new GitHubChangesetAdapter(REPO_URL, {}, { octokitOverride: octokit });

    expect(await adapter.search({ query: "test" })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// create() — delegates to repositoryBackend.pr.create, then re-fetches via Octokit
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.create (equivalence, mt#2613)", () => {
  test("delegates to the repository backend and returns the created changeset", async () => {
    const octokit = makeFakeOctokit({ pulls: { get: async () => ({ data: RAW_PR }) } });
    const backend = makeFakeBackend({});
    const adapter = new GitHubChangesetAdapter(
      REPO_URL,
      {},
      { octokitOverride: octokit, repositoryBackendOverride: backend }
    );

    const result = await adapter.create({
      title: "Test PR",
      description: "PR description",
      targetBranch: "main",
      sourceBranch: "feature",
    });

    expect(result.platformId).toBe(42);
    expect(result.url).toBe("https://github.com/edobry/minsky/pull/42");
    expect(result.changeset.id).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// approve() — delegates to repositoryBackend.review.approve
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.approve (equivalence, mt#2613)", () => {
  test("delegates to the repository backend and maps the approval result", async () => {
    const backend = makeFakeBackend({});
    const adapter = new GitHubChangesetAdapter(
      REPO_URL,
      {},
      { repositoryBackendOverride: backend }
    );

    const result = await adapter.approve("42", "looks good");

    expect(result).toEqual({ success: true, reviewId: "123" });
  });
});

// ---------------------------------------------------------------------------
// merge() — delegates to repositoryBackend.pr.merge
// ---------------------------------------------------------------------------

describe("GitHubChangesetAdapter.merge (equivalence, mt#2613)", () => {
  test("delegates to the repository backend and maps the merge result", async () => {
    const backend = makeFakeBackend({});
    const adapter = new GitHubChangesetAdapter(
      REPO_URL,
      {},
      { repositoryBackendOverride: backend }
    );

    const result = await adapter.merge("42", { deleteSourceBranch: true });

    expect(result.success).toBe(true);
    expect(result.mergeCommitSha).toBe("abc123def456");
    expect(result.mergedBy).toBe("octocat");
    expect(result.deletedBranch).toBe(true);
  });
});
