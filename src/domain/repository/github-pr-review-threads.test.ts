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
import { MinskyError } from "../../errors/index";
import { createOctokit, type GitHubContext } from "./github-pr-operations";

// ---------------------------------------------------------------------------
// String constants (no-magic-string-duplication rule)
// ---------------------------------------------------------------------------

const MUTATION_RESOLVE = "resolveReviewThread";
const MUTATION_UNRESOLVE = "unresolveReviewThread";
const MUTATION_NAME_RESOLVE = "mutation ResolveReviewThread";
const MUTATION_NAME_UNRESOLVE = "mutation UnresolveReviewThread";

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
function makeFakeOctokit(resolvedValue: unknown = {}) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const fakeGraphql = async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
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

    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error("Expected a graphql call");
    expect(call.query).toContain(MUTATION_RESOLVE);
    expect(call.variables).toEqual({ threadId: "thread-node-id" });
  });

  test("does NOT send the unresolveReviewThread mutation", async () => {
    const { octokit, calls } = makeFakeOctokit({
      resolveReviewThread: { thread: { id: "t1", isResolved: true } },
    });

    await resolveReviewThread(makeGh(), "t1", octokit);

    const call = calls[0];
    if (!call) throw new Error("Expected a graphql call");
    expect(call.query).not.toContain(MUTATION_UNRESOLVE);
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

    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error("Expected a graphql call");
    expect(call.query).toContain(MUTATION_UNRESOLVE);
    expect(call.variables).toEqual({ threadId: "thread-node-id" });
  });

  test("does NOT send the resolveReviewThread mutation", async () => {
    const { octokit, calls } = makeFakeOctokit({
      unresolveReviewThread: { thread: { id: "t1", isResolved: false } },
    });

    await unresolveReviewThread(makeGh(), "t1", octokit);

    const call = calls[0];
    if (!call) throw new Error("Expected a graphql call");
    // The query string must contain `unresolveReviewThread` but not
    // `resolveReviewThread` as a standalone mutation name.
    // The mutation body mentions `unresolveReviewThread` and the call-site
    // is `mutation UnresolveReviewThread` — check both to be precise.
    expect(call.query).toContain(MUTATION_UNRESOLVE);
    expect(call.query).not.toContain(MUTATION_NAME_RESOLVE);
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
    const { octokit, calls } = makeFakeOctokit({});

    await resolveReviewThread(makeGh(), "rt1", octokit);
    await unresolveReviewThread(makeGh(), "rt1", octokit);

    expect(calls.length).toBe(2);
    const firstCall = calls[0];
    const secondCall = calls[1];
    if (!firstCall || !secondCall) throw new Error("Expected two graphql calls");
    expect(firstCall.query).toContain(MUTATION_NAME_RESOLVE);
    expect(secondCall.query).toContain(MUTATION_NAME_UNRESOLVE);
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
