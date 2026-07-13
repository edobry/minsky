/**
 * Unit tests for review-thread resolution in github-pr-review.ts (mt#1342).
 *
 * Covers:
 *  - resolveReviewThread: sends the correct GraphQL mutation with the threadId variable
 *  - unresolveReviewThread: sends the correct mutation
 *  - Empty threadId throws MinskyError before any network call
 *
 * The network is never reached — tests use the `octokitOverride` DI seam so
 * no `mock.module()` is required (per the project's no-global-module-mocks rule).
 */

import { describe, expect, test } from "bun:test";
import { resolveReviewThread, unresolveReviewThread } from "./github-pr-review";
import { MinskyError } from "../errors/index";
import { createOctokit, type GitHubContext } from "./github-pr-operations";

// ---------------------------------------------------------------------------
// String constants (no-magic-string-duplication rule)
// ---------------------------------------------------------------------------

const MUTATION_RESOLVE = "resolveReviewThread";
const MUTATION_UNRESOLVE = "unresolveReviewThread";
const MUTATION_NAME_RESOLVE = "mutation ResolveReviewThread";
const MUTATION_NAME_UNRESOLVE = "mutation UnresolveReviewThread";
const TYPENAME_THREAD = "PullRequestReviewThread";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal GitHubContext stub. getToken never needs to be called in
 * tests that supply an octokitOverride — but it must be present for the type.
 */
function makeGh(): GitHubContext {
  return {
    owner: "test-owner",
    repo: "test-repo",
    getToken: async () => "fake-token",
  };
}

/**
 * Build a fake Octokit that records the GraphQL calls made against it.
 *
 * The returned object is compatible with the signature that `resolveReviewThread`
 * and `unresolveReviewThread` expect from `octokitOverride`.
 */
/**
 * Default ownership response: the thread belongs to the same owner/repo as
 * makeGh() (test-owner/test-repo). Tests that need a mismatched owner can
 * pass a custom ownershipResponse override.
 */
function defaultOwnershipResponse(threadId = "thread-node-id") {
  return {
    node: {
      __typename: TYPENAME_THREAD,
      id: threadId,
      repository: { owner: { login: "test-owner" }, name: "test-repo" },
      pullRequest: { number: 1 },
    },
  };
}

function makeFakeOctokit(
  resolvedValue: unknown = {},
  ownershipResponse: unknown = defaultOwnershipResponse()
) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const fakeGraphql = async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    // The ownership pre-check query is sent before the mutation; it has its
    // own response shape. Detect by query name and return the ownership
    // response for it; everything else gets the mutation resolved value.
    if (query.includes("ReviewThreadOwnership")) {
      return ownershipResponse;
    }
    return resolvedValue;
  };

  // Octokit exposes graphql as a tagged-template-literal function with extra methods.
  // We only use `octokit.graphql<T>(query, variables)` (the call form), so attaching
  // the async function is sufficient to satisfy the call site.
  const octokit = { graphql: fakeGraphql } as unknown as ReturnType<
    typeof import("./github-pr-operations").createOctokit
  >;

  return { octokit, calls };
}

// ---------------------------------------------------------------------------
// resolveReviewThread
// ---------------------------------------------------------------------------

describe("resolveReviewThread", () => {
  test("sends the resolveReviewThread mutation with the correct threadId", async () => {
    const { octokit, calls } = makeFakeOctokit({
      resolveReviewThread: { thread: { id: "thread-node-id", isResolved: true } },
    });

    await resolveReviewThread(makeGh(), "thread-node-id", octokit);

    // 2 calls: ownership pre-check at index 0, then the mutation at index 1.
    expect(calls.length).toBe(2);
    const mutationCall = calls[1];
    if (!mutationCall) throw new Error("Expected a mutation graphql call");
    expect(mutationCall.query).toContain(MUTATION_RESOLVE);
    expect(mutationCall.variables).toEqual({ threadId: "thread-node-id" });
  });

  test("does NOT send the unresolveReviewThread mutation", async () => {
    const { octokit, calls } = makeFakeOctokit(
      {
        resolveReviewThread: { thread: { id: "t1", isResolved: true } },
      },
      defaultOwnershipResponse("t1")
    );

    await resolveReviewThread(makeGh(), "t1", octokit);

    const mutationCall = calls[1];
    if (!mutationCall) throw new Error("Expected a mutation graphql call");
    expect(mutationCall.query).not.toContain(MUTATION_UNRESOLVE);
  });

  test("throws MinskyError for empty threadId before any network call", async () => {
    const { octokit, calls } = makeFakeOctokit();

    await expect(resolveReviewThread(makeGh(), "", octokit)).rejects.toBeInstanceOf(MinskyError);
    expect(calls.length).toBe(0);
  });

  test("throws MinskyError for whitespace-only threadId", async () => {
    const { octokit, calls } = makeFakeOctokit();

    await expect(resolveReviewThread(makeGh(), "   ", octokit)).rejects.toBeInstanceOf(MinskyError);
    expect(calls.length).toBe(0);
  });

  test("error message for empty threadId is descriptive", async () => {
    const { octokit } = makeFakeOctokit();

    let caught: unknown;
    try {
      await resolveReviewThread(makeGh(), "", octokit);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg.toLowerCase()).toContain("threadid");
  });
});

// ---------------------------------------------------------------------------
// unresolveReviewThread
// ---------------------------------------------------------------------------

describe("unresolveReviewThread", () => {
  test("sends the unresolveReviewThread mutation with the correct threadId", async () => {
    const { octokit, calls } = makeFakeOctokit({
      unresolveReviewThread: { thread: { id: "thread-node-id", isResolved: false } },
    });

    await unresolveReviewThread(makeGh(), "thread-node-id", octokit);

    // 2 calls: ownership pre-check at index 0, then the mutation at index 1.
    expect(calls.length).toBe(2);
    const mutationCall = calls[1];
    if (!mutationCall) throw new Error("Expected a mutation graphql call");
    expect(mutationCall.query).toContain(MUTATION_UNRESOLVE);
    expect(mutationCall.variables).toEqual({ threadId: "thread-node-id" });
  });

  test("does NOT send the resolveReviewThread mutation", async () => {
    const { octokit, calls } = makeFakeOctokit({
      unresolveReviewThread: { thread: { id: "t1", isResolved: false } },
    });

    await unresolveReviewThread(makeGh(), "t1", octokit);

    // Two calls: ownership pre-check (index 0), then the mutation (index 1).
    const mutationCall = calls[1];
    if (!mutationCall) throw new Error("Expected a mutation graphql call");
    // The query string must contain `unresolveReviewThread` but not
    // `resolveReviewThread` as a standalone mutation name.
    expect(mutationCall.query).toContain(MUTATION_UNRESOLVE);
    expect(mutationCall.query).not.toContain(MUTATION_NAME_RESOLVE);
  });

  test("throws MinskyError for empty threadId before any network call", async () => {
    const { octokit, calls } = makeFakeOctokit();

    await expect(unresolveReviewThread(makeGh(), "", octokit)).rejects.toBeInstanceOf(MinskyError);
    expect(calls.length).toBe(0);
  });

  test("throws MinskyError for whitespace-only threadId", async () => {
    const { octokit, calls } = makeFakeOctokit();

    await expect(unresolveReviewThread(makeGh(), "   ", octokit)).rejects.toBeInstanceOf(
      MinskyError
    );
    expect(calls.length).toBe(0);
  });

  test("error message for empty threadId is descriptive", async () => {
    const { octokit } = makeFakeOctokit();

    let caught: unknown;
    try {
      await unresolveReviewThread(makeGh(), "", octokit);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg.toLowerCase()).toContain("threadid");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: resolve then unresolve sends two separate mutations
// ---------------------------------------------------------------------------

describe("resolve / unresolve round trip", () => {
  test("calling resolve then unresolve sends two distinct mutations", async () => {
    const { octokit, calls } = makeFakeOctokit({}, defaultOwnershipResponse("rt1"));

    await resolveReviewThread(makeGh(), "rt1", octokit);
    await unresolveReviewThread(makeGh(), "rt1", octokit);

    // Each mutation is preceded by an ownership pre-check, so the call sequence
    // is: ownership, resolve, ownership, unresolve = 4 calls total.
    expect(calls.length).toBe(4);
    const resolveCall = calls[1];
    const unresolveCall = calls[3];
    if (!resolveCall || !unresolveCall) throw new Error("Expected two mutation calls");
    expect(resolveCall.query).toContain(MUTATION_NAME_RESOLVE);
    expect(unresolveCall.query).toContain(MUTATION_NAME_UNRESOLVE);
  });
});

// ---------------------------------------------------------------------------
// Production-path smoke test (mt#1342, PR #898 round 3)
// ---------------------------------------------------------------------------
//
// The reviewer-bot flagged a concern that octokit.graphql is undefined on
// @octokit/rest, which would break resolveReviewThread/unresolveReviewThread
// in production (where no octokitOverride is supplied). The override-based
// tests above don't catch that regression because they substitute their own
// graphql stub.
//
// This test exercises the production wiring: it constructs an Octokit via
// the real createOctokit factory (no override) and asserts the .graphql
// method exists and is callable. Network is never reached.
//
// @octokit/rest v22 is built on @octokit/core, which exposes graphql() on
// every Octokit instance via the standard plugin chain. If the dependency
// drifts (e.g. a future major version drops the graphql plugin), this test
// will fail and surface the regression before resolveReviewThread does.

describe("production path: createOctokit exposes .graphql", () => {
  test("createOctokit returns an instance with a callable graphql method", () => {
    const octokit = createOctokit("dummy-token-not-used");
    expect(typeof octokit.graphql).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Cross-repo guard (mt#1342, PR #898 round 4)
// ---------------------------------------------------------------------------
//
// GraphQL accepts any global node ID the bot token can access. Without the
// pre-mutation ownership check, a caller passing a valid threadId from a
// different repository would silently mutate that thread. These tests verify
// the guard rejects mismatched owner/repo before sending the mutation.

describe("cross-repo guard", () => {
  test("rejects threadId belonging to a different repository", async () => {
    // Ownership response says the thread is in `other-owner/other-repo`,
    // but makeGh() targets `test-owner/test-repo`.
    const mismatchedOwnership = {
      node: {
        __typename: TYPENAME_THREAD,
        id: "rt-foreign",
        repository: { owner: { login: "other-owner" }, name: "other-repo" },
        pullRequest: { number: 99 },
      },
    };
    const { octokit, calls } = makeFakeOctokit({}, mismatchedOwnership);

    await expect(resolveReviewThread(makeGh(), "rt-foreign", octokit)).rejects.toBeInstanceOf(
      MinskyError
    );

    // Only the ownership pre-check fires; the mutation is never sent.
    expect(calls.length).toBe(1);
    expect(calls[0]?.query).toContain("ReviewThreadOwnership");
  });

  test("rejects threadId that resolves to a non-PullRequestReviewThread node", async () => {
    const wrongTypeOwnership = {
      node: {
        __typename: "PullRequestReviewComment",
        id: "rc-1",
        // Repository/pullRequest fields are intentionally absent — they do
        // not appear on PullRequestReviewComment.
      },
    };
    const { octokit, calls } = makeFakeOctokit({}, wrongTypeOwnership);

    let caught: unknown;
    try {
      await unresolveReviewThread(makeGh(), "rc-1", octokit);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MinskyError);
    expect((caught as MinskyError).message).toContain("PullRequestReviewComment");
    expect(calls.length).toBe(1);
  });

  test("rejects threadId that resolves to a null node (not accessible to token)", async () => {
    const nullOwnership = { node: null };
    const { octokit, calls } = makeFakeOctokit({}, nullOwnership);

    await expect(resolveReviewThread(makeGh(), "rt-missing", octokit)).rejects.toBeInstanceOf(
      MinskyError
    );

    expect(calls.length).toBe(1);
  });

  test("accepts threadId belonging to the same repository (case-insensitive)", async () => {
    // Ownership returns mixed case; gh.owner/repo are lowercase. Should still match.
    const mixedCaseOwnership = {
      node: {
        __typename: TYPENAME_THREAD,
        id: "rt-case",
        repository: { owner: { login: "Test-Owner" }, name: "Test-Repo" },
        pullRequest: { number: 1 },
      },
    };
    const { octokit, calls } = makeFakeOctokit(
      { resolveReviewThread: { thread: { id: "rt-case", isResolved: true } } },
      mixedCaseOwnership
    );

    await resolveReviewThread(makeGh(), "rt-case", octokit);

    // Both the ownership pre-check and the mutation fire (no rejection).
    expect(calls.length).toBe(2);
  });
});
