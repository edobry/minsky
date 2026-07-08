/**
 * Tests for the session_pr_wait_for_review subcommand (mt#1203).
 *
 * Covers the polling loop, filter logic, and dependency-injection seams:
 * fake clock, fake sleep, and an injected backend whose listReviews is
 * driven by a scripted queue.
 */
import { describe, expect, test } from "bun:test";
import {
  annotateReviewRejections,
  explainReviewRejection,
  findMatchingReview,
  resolveReviewerFilter,
  sessionPrWaitForReview,
  type SessionPrWaitForReviewDependencies,
} from "./pr-wait-for-review-subcommand";
import type { ReviewListEntry, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";
import type { TokenProvider, TokenRole } from "../../auth/token-provider";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../errors/index";

/** Reviewer login used by test fixtures and filter-match assertions. */
const REVIEWER_BOT = "minsky-reviewer[bot]";
/** Implementer App login used by mt#1911 role-resolution test fixtures. */
const IMPLEMENTER_BOT = "minsky-ai[bot]";
/** Shared review-state literal (extracted per custom/no-magic-string-duplication). */
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;

describe("findMatchingReview", () => {
  function mkReview(overrides: Partial<ReviewListEntry>): ReviewListEntry {
    return {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-04-24T01:00:00Z",
      reviewerLogin: "someone",
      body: "",
      ...overrides,
    };
  }

  const since = Date.parse("2026-04-24T01:00:00Z");

  test("returns the first review at or after since", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: "2026-04-24T00:59:59Z" }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T01:00:00Z" }),
        mkReview({ reviewId: 3, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("skips reviews without a submittedAt timestamp", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: undefined }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("skips reviews with unparseable timestamps", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, submittedAt: "not-a-date" }),
        mkReview({ reviewId: 2, submittedAt: "2026-04-24T02:00:00Z" }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });

  test("reviewer filter matches case-insensitively", () => {
    const r = findMatchingReview(
      [
        mkReview({ reviewId: 1, reviewerLogin: "someone-else" }),
        mkReview({ reviewId: 2, reviewerLogin: "Minsky-Reviewer[bot]" }),
      ],
      since,
      REVIEWER_BOT
    );
    expect(r?.reviewId).toBe(2);
  });

  // mt#1906 regression: PR #1151 (mt#1887) wait-for-review missed two
  // matching reviews because the caller passed `reviewer: "minsky-reviewer"`
  // (bare form) while GitHub's API returns `minsky-reviewer[bot]`. The strict
  // case-insensitive equality rejected the match; 300s elapsed each time.
  const REVIEWER_BARE = "minsky-reviewer";
  test("reviewer filter matches when caller omits [bot] suffix", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: REVIEWER_BOT })],
      since,
      REVIEWER_BARE
    );
    expect(r?.reviewId).toBe(1);
  });

  test("reviewer filter matches when caller supplies [bot] suffix and review omits it", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: REVIEWER_BARE })],
      since,
      REVIEWER_BOT
    );
    expect(r?.reviewId).toBe(1);
  });

  test("reviewer filter only strips a trailing [bot], not mid-string", () => {
    // A login like "minsky-reviewer[bot]-staging" must NOT normalize to
    // "minsky-reviewer-staging"; the `[bot]` is a positional suffix marker,
    // not a generic substring to drop.
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: `${REVIEWER_BOT}-staging` })],
      since,
      REVIEWER_BARE
    );
    expect(r).toBeUndefined();
  });

  test("reviewer filter rejects non-matches even if review is recent", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: "someone-else" })],
      since,
      REVIEWER_BOT
    );
    expect(r).toBeUndefined();
  });

  test("reviewer filter handles null reviewerLogin", () => {
    const r = findMatchingReview(
      [mkReview({ reviewId: 1, reviewerLogin: null })],
      since,
      REVIEWER_BOT
    );
    expect(r).toBeUndefined();
  });

  test("returns undefined on empty input", () => {
    const r = findMatchingReview([], since, undefined);
    expect(r).toBeUndefined();
  });

  test("excludes PENDING reviews from matching (drafts)", () => {
    const r = findMatchingReview(
      [
        mkReview({
          reviewId: 1,
          state: "PENDING",
          submittedAt: "2026-04-24T02:00:00Z",
          reviewerLogin: "someone",
        }),
        mkReview({
          reviewId: 2,
          state: "APPROVED",
          submittedAt: "2026-04-24T02:00:00Z",
          reviewerLogin: "someone",
        }),
      ],
      since,
      undefined
    );
    expect(r?.reviewId).toBe(2);
  });
});

describe("resolveReviewerFilter", () => {
  // mt#1911: TokenRole-aligned role identifiers as alternative to literal logins.
  // Reuses top-level REVIEWER_BOT / IMPLEMENTER_BOT constants for the App identities.

  function makeTokenProvider(opts: {
    rolesConfigured: TokenRole[];
    identities?: Partial<Record<TokenRole, { login: string; type: "app" | "user" } | null>>;
  }): TokenProvider {
    return {
      getToken: async () => "stub-token",
      getServiceToken: async () => "stub-token",
      getUserToken: async () => "stub-user-token",
      getServiceIdentity: async (role?: TokenRole) => {
        const resolved = role ?? "implementer";
        if (opts.identities && resolved in opts.identities) {
          return opts.identities[resolved] ?? null;
        }
        if (resolved === "reviewer") return { login: REVIEWER_BOT, type: "app" };
        return { login: IMPLEMENTER_BOT, type: "app" };
      },
      isServiceAccountConfigured: () => opts.rolesConfigured.includes("implementer"),
      isRoleConfigured: (role: TokenRole) => opts.rolesConfigured.includes(role),
    };
  }

  test("returns undefined when reviewer is undefined (no filter)", async () => {
    const tp = makeTokenProvider({ rolesConfigured: ["implementer", "reviewer"] });
    const resolved = await resolveReviewerFilter(undefined, async () => tp);
    expect(resolved).toBeUndefined();
  });

  test("passes literal logins through unchanged (no TokenProvider lookup)", async () => {
    // The TokenProvider must NOT be consulted for literal-login filters.
    // Use a provider that throws if called to assert this.
    const callCounter = { n: 0 };
    const getTp = async (): Promise<TokenProvider> => {
      callCounter.n += 1;
      throw new Error("getTokenProvider should not be called for literal logins");
    };
    expect(await resolveReviewerFilter("minsky-reviewer", getTp)).toBe("minsky-reviewer");
    expect(await resolveReviewerFilter(REVIEWER_BOT, getTp)).toBe(REVIEWER_BOT);
    expect(await resolveReviewerFilter("some-human-login", getTp)).toBe("some-human-login");
    expect(callCounter.n).toBe(0);
  });

  test("resolves reviewer role to App login when configured", async () => {
    const tp = makeTokenProvider({ rolesConfigured: ["implementer", "reviewer"] });
    const resolved = await resolveReviewerFilter("reviewer", async () => tp);
    expect(resolved).toBe(REVIEWER_BOT);
  });

  test("resolves implementer role to App login when configured", async () => {
    const tp = makeTokenProvider({ rolesConfigured: ["implementer"] });
    const resolved = await resolveReviewerFilter("implementer", async () => tp);
    expect(resolved).toBe(IMPLEMENTER_BOT);
  });

  test("role identifier match is case-insensitive", async () => {
    const tp = makeTokenProvider({ rolesConfigured: ["implementer", "reviewer"] });
    expect(await resolveReviewerFilter("Reviewer", async () => tp)).toBe(REVIEWER_BOT);
    expect(await resolveReviewerFilter("REVIEWER", async () => tp)).toBe(REVIEWER_BOT);
    expect(await resolveReviewerFilter("Implementer", async () => tp)).toBe(IMPLEMENTER_BOT);
  });

  test("throws typed MinskyError naming config key when reviewer role unconfigured", async () => {
    const tp = makeTokenProvider({ rolesConfigured: ["implementer"] }); // reviewer absent
    let err: unknown;
    try {
      await resolveReviewerFilter("reviewer", async () => tp);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MinskyError);
    expect((err as MinskyError).message).toContain("github.reviewer.serviceAccount");
    expect((err as MinskyError).message).toContain("not configured");
  });

  test("throws typed MinskyError naming config key when implementer role unconfigured", async () => {
    const tp = makeTokenProvider({ rolesConfigured: [] }); // neither configured
    let err: unknown;
    try {
      await resolveReviewerFilter("implementer", async () => tp);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MinskyError);
    expect((err as MinskyError).message).toContain("github.serviceAccount");
  });

  test("throws when TokenProvider returns null identity despite role configured (defensive)", async () => {
    // Inconsistency check: isRoleConfigured says yes but getServiceIdentity returns null.
    const tp = makeTokenProvider({
      rolesConfigured: ["implementer", "reviewer"],
      identities: { reviewer: null },
    });
    let err: unknown;
    try {
      await resolveReviewerFilter("reviewer", async () => tp);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MinskyError);
    expect((err as MinskyError).message).toContain("inconsistency");
  });

  // R1 NON-BLOCKING fix (PR #1157): TokenProvider acquisition failures
  // (e.g. `getConfiguration()` throwing "Configuration not initialized.")
  // must surface as a typed MinskyError naming the role context, not bubble
  // out as a generic Error that the outer try/catch wraps as
  // "Failed to wait for PR review: ..."
  test("wraps TokenProvider acquisition failures with role-named MinskyError", async () => {
    const getTp = async (): Promise<TokenProvider> => {
      throw new Error("Configuration not initialized. Call initializeConfiguration() first.");
    };
    let err: unknown;
    try {
      await resolveReviewerFilter("reviewer", getTp);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MinskyError);
    expect((err as MinskyError).message).toContain('Cannot resolve reviewer role "reviewer"');
    expect((err as MinskyError).message).toContain("failed to acquire TokenProvider");
    expect((err as MinskyError).message).toContain("Configuration not initialized");
  });

  test("literal login that resembles a role but isn't exact passes through", async () => {
    // "reviewer-bot" is NOT the literal role identifier "reviewer" (case-insensitive
    // strict match). Treat as a literal login.
    const callCounter = { n: 0 };
    const getTp = async (): Promise<TokenProvider> => {
      callCounter.n += 1;
      throw new Error("should not be called");
    };
    expect(await resolveReviewerFilter("reviewer-bot", getTp)).toBe("reviewer-bot");
    expect(await resolveReviewerFilter("some-reviewer", getTp)).toBe("some-reviewer");
    expect(callCounter.n).toBe(0);
  });
});

describe("sessionPrWaitForReview", () => {
  const sessionId = "test-session";
  const prNumber = 123;

  function makeDeps(
    reviewsQueue: ReviewListEntry[][],
    clockStart = 1_000_000,
    backendOverrides: {
      /**
       * Optional mt#2043 hook: when set, the stub backend exposes
       * `getPullRequestCreatedAt` returning this ISO string.
       * When `undefined`, the backend does NOT implement the method,
       * exercising the non-GitHub-backend fallback path (since = call start).
       */
      prCreatedAt?: string;
      /**
       * When set, `getPullRequestCreatedAt` throws this error instead of
       * returning a value. Lets the typed-error path be tested.
       */
      prCreatedAtError?: Error;
    } = {}
  ): SessionPrWaitForReviewDependencies & {
    listCalls: number;
    sleepCalls: number[];
    createdAtCalls: number;
  } {
    let clock = clockStart;
    let listIdx = 0;
    let createdAtCalls = 0;
    const sleepCalls: number[] = [];

    const sessionRecord: SessionRecord = {
      session: sessionId,
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date(clockStart).toISOString(),
      pullRequest: { number: prNumber, branch: "task/mt-test", baseBranch: "main" },
      taskId: "mt#1203",
    } as unknown as SessionRecord;

    const sessionDB = {
      getSession: async (id: string) => (id === sessionId ? sessionRecord : null),
    } as unknown as SessionProviderInterface;

    const reviewObj: Record<string, unknown> = {
      listReviews: async () => {
        const next = reviewsQueue[listIdx] ?? reviewsQueue[reviewsQueue.length - 1] ?? [];
        listIdx++;
        return next;
      },
    };
    if (backendOverrides.prCreatedAt !== undefined || backendOverrides.prCreatedAtError) {
      reviewObj.getPullRequestCreatedAt = async () => {
        createdAtCalls++;
        if (backendOverrides.prCreatedAtError) throw backendOverrides.prCreatedAtError;
        return backendOverrides.prCreatedAt as string;
      };
    }

    const backend: RepositoryBackend = {
      review: reviewObj,
    } as unknown as RepositoryBackend;

    const deps = {
      sessionDB,
      createBackend: async () => backend,
      now: () => clock,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      get listCalls() {
        return listIdx;
      },
      get sleepCalls() {
        return sleepCalls;
      },
      get createdAtCalls() {
        return createdAtCalls;
      },
    };

    return deps as unknown as SessionPrWaitForReviewDependencies & {
      listCalls: number;
      sleepCalls: number[];
      createdAtCalls: number;
    };
  }

  // We need to stub resolveSessionContextWithFeedback since it hits the
  // session resolver directly. The simplest reliable approach is to pass
  // sessionId explicitly, which short-circuits auto-detection.
  //
  // But resolveSessionContextWithFeedback will still try to validate the id
  // against the session DB. Our sessionDB.getSession returns the record for
  // the known id, which should be enough.

  const match: ReviewListEntry = {
    reviewId: 42,
    state: "CHANGES_REQUESTED",
    submittedAt: "2099-01-01T00:00:00Z", // far in the future → always >= since
    reviewerLogin: REVIEWER_BOT,
    body: "adversarial review body",
    htmlUrl: "https://github.com/edobry/minsky/pull/123#pullrequestreview-42",
  };

  test("returns match on the first poll when a review is already present", async () => {
    const deps = makeDeps([[match]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 30, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
      expect(result.pollCount).toBe(1);
    }
    expect(deps.sleepCalls).toHaveLength(0);
  });

  test("polls until a review appears", async () => {
    const deps = makeDeps([[], [], [match]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 60, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.pollCount).toBe(3);
    }
    // 2 sleeps between 3 polls
    expect(deps.sleepCalls).toHaveLength(2);
    expect(deps.sleepCalls[0]).toBe(5000);
  });

  test("returns matched=false on timeout with no review", async () => {
    // Queue returns empty indefinitely (makeDeps repeats last entry).
    const deps = makeDeps([[]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 10, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(false);
    // With 10s budget and 5s interval: poll, sleep 5, poll, sleep 5, poll, no
    // time left → 3 polls.
    expect(result.pollCount).toBeGreaterThanOrEqual(2);
  });

  test("reviewer filter excludes non-matching reviews", async () => {
    const unrelated: ReviewListEntry = {
      ...match,
      reviewerLogin: "some-other-bot",
      reviewId: 7,
    };
    const deps = makeDeps([[unrelated], [unrelated, match]]);
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 60,
        intervalSeconds: 5,
        reviewer: REVIEWER_BOT,
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
      expect(result.pollCount).toBe(2);
    }
  });

  test("since filter ignores pre-existing old reviews", async () => {
    const oldReview: ReviewListEntry = {
      ...match,
      reviewId: 1,
      submittedAt: "2020-01-01T00:00:00Z",
    };
    const deps = makeDeps([[oldReview], [oldReview, match]]);
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 60,
        intervalSeconds: 5,
        since: "2025-01-01T00:00:00Z",
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
    }
  });

  test("throws ResourceNotFoundError when session has no PR", async () => {
    const deps = makeDeps([[]]);
    const noPrRecord: SessionRecord = {
      session: sessionId,
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date().toISOString(),
    } as unknown as SessionRecord;
    deps.sessionDB = {
      getSession: async () => noPrRecord,
    } as unknown as SessionProviderInterface;

    await expect(
      sessionPrWaitForReview({ sessionId, timeoutSeconds: 5, intervalSeconds: 5 }, deps)
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("throws ValidationError when since is not a parseable timestamp", async () => {
    const deps = makeDeps([[]]);
    await expect(
      sessionPrWaitForReview(
        { sessionId, timeoutSeconds: 5, intervalSeconds: 5, since: "not-a-date" },
        deps
      )
    ).rejects.toThrow(ValidationError);
  });

  test("throws MinskyError when backend does not implement listReviews", async () => {
    const deps = makeDeps([[]]);
    // Override createBackend to return a backend without listReviews support
    // (simulating a non-GitHub backend that hasn't implemented the optional
    // method).
    deps.createBackend = async () =>
      ({
        review: {
          // listReviews intentionally absent
        },
      }) as unknown as RepositoryBackend;

    await expect(
      sessionPrWaitForReview({ sessionId, timeoutSeconds: 5, intervalSeconds: 5 }, deps)
    ).rejects.toThrow(/does not support listing reviews/);
  });

  test("does not poll past the deadline (exact-deadline semantics)", async () => {
    // With timeout=10s and interval=5s, the expected poll schedule is:
    //   t=0: poll 1
    //   sleep 5s → t=5
    //   t=5: poll 2
    //   sleep 5s → t=10 (at deadline)
    //   pre-poll deadline check fires: no poll 3.
    // Before the R1-blocking fix, the loop would have done a 3rd poll at
    // t=10 before returning timeout. This test is the regression guard.
    const deps = makeDeps([[]]);
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 10, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.pollCount).toBe(2);
    }
  });

  // mt#1911: role-resolution wires through the polling loop end-to-end.
  test("reviewer role identifier resolves and matches at filter time", async () => {
    const tp: TokenProvider = {
      getToken: async () => "stub",
      getServiceToken: async () => "stub",
      getUserToken: async () => "stub",
      getServiceIdentity: async () => ({ login: REVIEWER_BOT, type: "app" }),
      isServiceAccountConfigured: () => true,
      isRoleConfigured: () => true,
    };
    const deps = makeDeps([[match]]);
    deps.getTokenProvider = async () => tp;
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 30, intervalSeconds: 5, reviewer: "reviewer" },
      deps
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewerLogin).toBe(REVIEWER_BOT);
    }
  });

  test("reviewer role identifier with unconfigured role throws before polling", async () => {
    const tp: TokenProvider = {
      getToken: async () => "stub",
      getServiceToken: async () => "stub",
      getUserToken: async () => "stub",
      getServiceIdentity: async () => null,
      isServiceAccountConfigured: () => false,
      isRoleConfigured: () => false,
    };
    const deps = makeDeps([[match]]);
    deps.getTokenProvider = async () => tp;
    await expect(
      sessionPrWaitForReview(
        { sessionId, timeoutSeconds: 30, intervalSeconds: 5, reviewer: "reviewer" },
        deps
      )
    ).rejects.toThrow(/github\.reviewer\.serviceAccount/);
    // Critical: no polls occurred — the throw is at filter setup, before backend.review.listReviews.
    expect(deps.listCalls).toBe(0);
  });

  test("handles a large (paginated-equivalent) review list without losing the match", async () => {
    // The real pagination lives in github-pr-review.ts (octokit.paginate);
    // at the subcommand layer we just need to confirm findMatchingReview
    // scans the whole list and a match deep in the array is still found.
    // Simulate a backend that returns 150 historical reviews + 1 matching
    // review at the end — the equivalent of a page-3 result that a
    // non-paginated implementation would miss.
    const historical: ReviewListEntry[] = Array.from({ length: 150 }, (_, i) => ({
      reviewId: i + 1,
      state: "COMMENTED",
      submittedAt: "2020-01-01T00:00:00Z",
      reviewerLogin: "random-user",
      body: "historical noise",
    }));
    const deps = makeDeps([[...historical, match]]);
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 30,
        intervalSeconds: 5,
        // Exclude all historical 2020 reviews via an explicit since; the
        // match's 2099 timestamp clears it comfortably.
        since: "2099-01-01T00:00:00Z",
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(42);
      expect(result.pollCount).toBe(1);
    }
  });

  test("refreshes HEAD each poll: a review of the prior HEAD stops matching after HEAD advances (mt#2586)", async () => {
    const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const reviewA: ReviewListEntry = {
      reviewId: 1,
      state: CHANGES_REQUESTED_STATE,
      submittedAt: "2026-05-21T18:35:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: HEAD_A,
    };
    const reviewB: ReviewListEntry = {
      reviewId: 2,
      state: "APPROVED",
      submittedAt: "2026-05-21T18:40:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: HEAD_B,
    };
    // HEAD advances A -> B on poll 2. reviewA (of the OLD head) surfaces on
    // poll 2 and MUST be rejected because the refreshed HEAD is now B; a
    // resolve-once implementation would erroneously match it here. reviewB
    // (of the new head) surfaces on poll 3 and matches.
    const headShaScript = [HEAD_A, HEAD_B, HEAD_B];
    const reviewsScript: ReviewListEntry[][] = [[], [reviewA], [reviewA, reviewB]];
    let headIdx = 0;
    let listIdx = 0;
    let clock = 1_000_000;

    const sessionRecord = {
      session: "s",
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date(0).toISOString(),
      pullRequest: { number: 123, branch: "task/mt-test", baseBranch: "main" },
      taskId: "mt#2586",
    } as unknown as SessionRecord;

    const backend = {
      review: {
        listReviews: async () => reviewsScript[Math.min(listIdx++, reviewsScript.length - 1)],
        getPullRequestCreatedAt: async () => new Date(0).toISOString(),
        getPullRequestHeadSha: async () =>
          headShaScript[Math.min(headIdx++, headShaScript.length - 1)],
      },
    } as unknown as RepositoryBackend;

    const deps = {
      sessionDB: { getSession: async () => sessionRecord } as unknown as SessionProviderInterface,
      createBackend: async () => backend,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    } as unknown as SessionPrWaitForReviewDependencies;

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 60 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(2);
      expect(result.pollCount).toBe(3);
    }
  });
});

// ============================================================================
// mt#2043 — since-default = PR created_at + timeout diagnostic visibility
// ============================================================================

describe("explainReviewRejection (mt#2043)", () => {
  const since = Date.parse("2026-05-21T18:32:55Z");

  test("returns null for a matching review", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    expect(explainReviewRejection(r, since, REVIEWER_BOT)).toBeNull();
  });

  test("returns state-pending for PENDING drafts", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "PENDING",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    expect(explainReviewRejection(r, since, undefined)).toMatch(/^state-pending:/);
  });

  test("returns missing-submittedAt when submittedAt is undefined", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: undefined,
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    expect(explainReviewRejection(r, since, undefined)).toMatch(/^missing-submittedAt:/);
  });

  test("returns unparseable-submittedAt when submittedAt is malformed", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "not-a-date",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    expect(explainReviewRejection(r, since, undefined)).toMatch(
      /^unparseable-submittedAt: not-a-date/
    );
  });

  test("returns since:... when review predates the threshold (mt#2043 originating bug)", () => {
    // This is the exact shape of the mt#2031 bug: the COMMENT review at
    // 18:35:57Z fell BEFORE the wait's effective `since` (the call start at
    // 18:51:57Z under the old default). Reproduce the rejection text agents
    // would see post-mt#2043 to diagnose the same incident.
    const callStart = Date.parse("2026-05-21T18:51:57Z");
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    const reason = explainReviewRejection(r, callStart, REVIEWER_BOT);
    expect(reason).toMatch(/^since:/);
    expect(reason).toContain("2026-05-21T18:35:57Z");
    expect(reason).toContain("2026-05-21T18:51:57");
  });

  test("returns reviewer-mismatch when reviewer filter excludes the entry", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: "someone-else",
      body: "",
    };
    const reason = explainReviewRejection(r, since, REVIEWER_BOT);
    expect(reason).toMatch(/^reviewer-mismatch:/);
    expect(reason).toContain("someone-else");
    expect(reason).toContain(REVIEWER_BOT);
  });

  test("reviewer-mismatch reports <null> when reviewerLogin is null", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: null,
      body: "",
    };
    const reason = explainReviewRejection(r, since, REVIEWER_BOT);
    expect(reason).toMatch(/^reviewer-mismatch:/);
    expect(reason).toContain("<null>");
  });
});

// ============================================================================
// mt#2586 — HEAD-freshness: reject reviews of a superseded commit
// ============================================================================

describe("explainReviewRejection — HEAD-freshness (mt#2586)", () => {
  const since = Date.parse("2026-05-21T18:32:55Z");
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const CR_STATE = CHANGES_REQUESTED_STATE;

  test("rejects a review submitted against a superseded commit", () => {
    const r: ReviewListEntry = {
      reviewId: 1,
      state: CR_STATE,
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: OLD,
    };
    const reason = explainReviewRejection(r, since, REVIEWER_BOT, HEAD);
    expect(reason).toMatch(/^stale-head:/);
    expect(reason).toContain(OLD);
    expect(reason).toContain(HEAD);
  });

  test("matches a review submitted against the current HEAD", () => {
    const r: ReviewListEntry = {
      reviewId: 2,
      state: "APPROVED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: HEAD,
    };
    expect(explainReviewRejection(r, since, REVIEWER_BOT, HEAD)).toBeNull();
  });

  test("reports <none> when the stale review carries no commitId", () => {
    const r: ReviewListEntry = {
      reviewId: 3,
      state: CR_STATE,
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    const reason = explainReviewRejection(r, since, REVIEWER_BOT, HEAD);
    expect(reason).toMatch(/^stale-head:/);
    expect(reason).toContain("<none>");
  });

  test("skips the HEAD check entirely when headSha is undefined (fallback path)", () => {
    const r: ReviewListEntry = {
      reviewId: 4,
      state: CR_STATE,
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: OLD,
    };
    // No headSha => no HEAD filter => matches (pre-mt#2586 behavior preserved).
    expect(explainReviewRejection(r, since, REVIEWER_BOT, undefined)).toBeNull();
  });

  test("findMatchingReview skips the stale-head review and returns the fresh one", () => {
    const stale: ReviewListEntry = {
      reviewId: 10,
      state: CR_STATE,
      submittedAt: "2026-05-21T18:35:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: OLD,
    };
    const fresh: ReviewListEntry = {
      reviewId: 11,
      state: "APPROVED",
      submittedAt: "2026-05-21T18:40:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: HEAD,
    };
    const match = findMatchingReview([stale, fresh], since, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(11);
  });

  test("findMatchingReview returns undefined when only a stale-head review exists (the mt#2586 stall)", () => {
    const stale: ReviewListEntry = {
      reviewId: 12,
      state: CR_STATE,
      submittedAt: "2026-05-21T18:35:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
      commitId: OLD,
    };
    expect(findMatchingReview([stale], since, REVIEWER_BOT, HEAD)).toBeUndefined();
  });
});

describe("annotateReviewRejections (mt#2043)", () => {
  const since = Date.parse("2026-05-21T18:32:55Z");

  test("annotates each review with its rejection reason", () => {
    const reviews: ReviewListEntry[] = [
      {
        reviewId: 1,
        state: "PENDING",
        submittedAt: "2026-05-21T18:35:57Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      {
        reviewId: 2,
        state: "COMMENTED",
        submittedAt: "2020-01-01T00:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      {
        reviewId: 3,
        state: "APPROVED",
        submittedAt: "2026-05-21T19:00:00Z",
        reviewerLogin: "someone-else",
        body: "",
      },
    ];
    const annotated = annotateReviewRejections(reviews, since, REVIEWER_BOT);
    expect(annotated).toHaveLength(3);
    const [pending, oldReview, wrongReviewer] = annotated;
    expect(pending?.rejectionReason).toMatch(/^state-pending:/);
    expect(oldReview?.rejectionReason).toMatch(/^since:/);
    expect(wrongReviewer?.rejectionReason).toMatch(/^reviewer-mismatch:/);
    // Original review fields are preserved.
    expect(pending?.reviewId).toBe(1);
    expect(oldReview?.reviewId).toBe(2);
    expect(wrongReviewer?.reviewId).toBe(3);
  });

  test("returns empty array for empty input", () => {
    expect(annotateReviewRejections([], since, undefined)).toEqual([]);
  });

  test("matching reviews get the defensive-fallback reason (only reachable in tests)", () => {
    // In production this code path is unreachable — the wait loop returns
    // on first match before annotation. The defensive fallback is here so
    // callers passing a matching review through `annotateReviewRejections`
    // (e.g., for direct test inspection) don't crash on a null assignment.
    const reviews: ReviewListEntry[] = [
      {
        reviewId: 1,
        state: "COMMENTED",
        submittedAt: "2026-05-21T19:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
    ];
    const annotated = annotateReviewRejections(reviews, since, REVIEWER_BOT);
    const [only] = annotated;
    expect(only?.rejectionReason).toMatch(/^matched:/);
  });
});

describe("sessionPrWaitForReview since-default = PR created_at (mt#2043)", () => {
  const sessionId = "test-session";
  const prNumber = 123;

  // Replays the makeDeps helper inline here so the mt#2043 tests are
  // self-contained — see the parent describe block's makeDeps for the
  // canonical version. Identical signature plus the `backendOverrides`
  // argument (already added to makeDeps).
  function makeMt2043Deps(
    reviewsQueue: ReviewListEntry[][],
    clockStart: number,
    backendOverrides: { prCreatedAt?: string; prCreatedAtError?: Error } = {}
  ) {
    let clock = clockStart;
    let listIdx = 0;
    let createdAtCalls = 0;
    const sleepCalls: number[] = [];

    const sessionRecord: SessionRecord = {
      session: sessionId,
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: new Date(clockStart).toISOString(),
      pullRequest: { number: prNumber, branch: "task/mt-test", baseBranch: "main" },
      taskId: "mt#2043",
    } as unknown as SessionRecord;

    const sessionDB = {
      getSession: async (id: string) => (id === sessionId ? sessionRecord : null),
    } as unknown as SessionProviderInterface;

    const reviewObj: Record<string, unknown> = {
      listReviews: async () => {
        const next = reviewsQueue[listIdx] ?? reviewsQueue[reviewsQueue.length - 1] ?? [];
        listIdx++;
        return next;
      },
    };
    if (backendOverrides.prCreatedAt !== undefined || backendOverrides.prCreatedAtError) {
      reviewObj.getPullRequestCreatedAt = async () => {
        createdAtCalls++;
        if (backendOverrides.prCreatedAtError) throw backendOverrides.prCreatedAtError;
        return backendOverrides.prCreatedAt as string;
      };
    }

    const backend: RepositoryBackend = {
      review: reviewObj,
    } as unknown as RepositoryBackend;

    return {
      sessionDB,
      createBackend: async () => backend,
      now: () => clock,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      get listCalls() {
        return listIdx;
      },
      get sleepCalls() {
        return sleepCalls;
      },
      get createdAtCalls() {
        return createdAtCalls;
      },
    } as unknown as SessionPrWaitForReviewDependencies & {
      listCalls: number;
      sleepCalls: number[];
      createdAtCalls: number;
    };
  }

  test("originating-incident regression: pre-existing COMMENT review matches by default", async () => {
    // Replays the mt#2031 timeline:
    //   T0 = PR created at 18:32:55Z
    //   T1 = bot posts COMMENT at 18:35:57Z
    //   T2 = wait invoked at 18:51:57Z (16 min after the review)
    // Pre-mt#2043 default since=T2 silently excluded T1.
    // Post-mt#2043 default since=T0 includes T1 → match on first poll.
    const prCreatedAt = "2026-05-21T18:32:55Z";
    const callStart = Date.parse("2026-05-21T18:51:57Z");
    const commentReview: ReviewListEntry = {
      reviewId: 4339665649,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "Non-blocking findings; do not block merge.",
    };

    const deps = makeMt2043Deps([[commentReview]], callStart, { prCreatedAt });
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 30, intervalSeconds: 5, reviewer: REVIEWER_BOT },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(4339665649);
      expect(result.pollCount).toBe(1);
    }
    expect(deps.createdAtCalls).toBe(1);
  });

  test("explicit since wins over backend lookup; no created_at call", async () => {
    const prCreatedAt = "2026-05-21T18:32:55Z";
    const callStart = Date.parse("2026-05-21T18:51:57Z");
    // With explicit since=18:51:57Z, the pre-existing comment at 18:35:57Z
    // must be excluded (reproducing the mt#2031 incident shape on purpose).
    const commentReview: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    const deps = makeMt2043Deps([[commentReview]], callStart, { prCreatedAt });
    const result = await sessionPrWaitForReview(
      {
        sessionId,
        timeoutSeconds: 10,
        intervalSeconds: 5,
        reviewer: REVIEWER_BOT,
        since: "2026-05-21T18:51:57Z",
      },
      deps
    );

    expect(result.matched).toBe(false);
    expect(deps.createdAtCalls).toBe(0); // explicit since bypassed backend lookup
  });

  test("backend without getPullRequestCreatedAt falls back to call-start (pre-mt#2043 default)", async () => {
    // No prCreatedAt → backend object omits the optional method.
    const callStart = Date.parse("2026-05-21T18:51:57Z");
    const commentReview: ReviewListEntry = {
      reviewId: 1,
      state: "COMMENTED",
      submittedAt: "2026-05-21T18:35:57Z",
      reviewerLogin: REVIEWER_BOT,
      body: "",
    };
    const deps = makeMt2043Deps([[commentReview]], callStart, {}); // no prCreatedAt
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 10, intervalSeconds: 5, reviewer: REVIEWER_BOT },
      deps
    );

    // Fallback since = callStart → the pre-existing review is excluded (the
    // pre-mt#2043 behavior, preserved for non-GitHub backends).
    expect(result.matched).toBe(false);
    expect(deps.createdAtCalls).toBe(0);
  });

  test("backend returns unparseable created_at → throws MinskyError naming the value", async () => {
    const deps = makeMt2043Deps([[]], Date.now(), { prCreatedAt: "garbage-timestamp" });
    let err: unknown;
    try {
      await sessionPrWaitForReview({ sessionId, timeoutSeconds: 5, intervalSeconds: 5 }, deps);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MinskyError);
    expect((err as MinskyError).message).toContain("garbage-timestamp");
    expect((err as MinskyError).message).toContain("unparseable PR created_at");
  });

  test("timeout payload includes lastSeenReviews with rejection reasons + sinceUsed", async () => {
    const prCreatedAt = "2026-05-21T18:32:55Z";
    const callStart = Date.parse("2026-05-21T18:51:57Z");
    // Three reviews, none matching for different reasons:
    //   1: wrong reviewer
    //   2: predates PR creation (would be rejected by since)
    //   3: PENDING draft
    const lastPoll: ReviewListEntry[] = [
      {
        reviewId: 1,
        state: "COMMENTED",
        submittedAt: "2026-05-21T18:40:00Z",
        reviewerLogin: "someone-else",
        body: "",
      },
      {
        reviewId: 2,
        state: "APPROVED",
        submittedAt: "2026-05-21T17:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      {
        reviewId: 3,
        state: "PENDING",
        submittedAt: "2026-05-21T18:45:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
    ];
    const deps = makeMt2043Deps([lastPoll], callStart, { prCreatedAt });
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 10, intervalSeconds: 5, reviewer: REVIEWER_BOT },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.lastSeenReviews).toHaveLength(3);
      const [wrong, old, pending] = result.lastSeenReviews;
      expect(wrong?.rejectionReason).toMatch(/^reviewer-mismatch:/);
      // Review 2 was filtered by since (PR creation time) — predates 18:32:55Z
      // would not match, but 17:00:00Z DOES predate 18:32:55Z so this is a
      // since-rejection.
      expect(old?.rejectionReason).toMatch(/^since:/);
      expect(pending?.rejectionReason).toMatch(/^state-pending:/);
      // sinceUsed reflects the resolved default (PR created_at).
      expect(result.sinceUsed).toBe("2026-05-21T18:32:55.000Z");
    }
  });

  test("timeout payload has empty lastSeenReviews when backend returns no reviews", async () => {
    const prCreatedAt = "2026-05-21T18:32:55Z";
    const deps = makeMt2043Deps([[]], Date.parse("2026-05-21T18:51:57Z"), { prCreatedAt });
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 5, intervalSeconds: 5 },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.lastSeenReviews).toEqual([]);
      expect(result.sinceUsed).toBe("2026-05-21T18:32:55.000Z");
    }
  });

  test("timeout payload sinceUsed reflects explicit since when caller provides one", async () => {
    const prCreatedAt = "2026-05-21T18:32:55Z";
    const explicitSince = "2026-05-21T20:00:00Z";
    const deps = makeMt2043Deps([[]], Date.parse("2026-05-21T18:51:57Z"), { prCreatedAt });
    const result = await sessionPrWaitForReview(
      { sessionId, timeoutSeconds: 5, intervalSeconds: 5, since: explicitSince },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.sinceUsed).toBe("2026-05-21T20:00:00.000Z");
    }
    // Backend lookup skipped on explicit since.
    expect(deps.createdAtCalls).toBe(0);
  });
});
