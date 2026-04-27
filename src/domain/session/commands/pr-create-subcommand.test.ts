/**
 * Tests for the session_pr_create quality.review Ask integration.
 *
 * Covers (mt#1239 + mt#1384):
 *   - parsePrNumber / parseGithubPrUrl URL parsers
 *   - fileQualityReviewAsk writer — canonical github-pr:<owner>/<repo>/<n> form
 *     and PR URL preservation in contextRef description
 *   - End-to-end Ask integration: file Ask → run reconcile → assert
 *     state transitions to `responded` and operator-notify is called
 *
 * All tests are hermetic: no real DB, no real git, no real GitHub API.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { fileQualityReviewAsk, parseGithubPrUrl, parsePrNumber } from "./pr-create-subcommand";
import { FakeAskRepository } from "../../ask/repository";
import { reconcile, type GithubReview, type GithubReviewClient } from "../../ask/reconciler";
import type { OperatorNotify } from "../../notify/operator-notify";

// ---------------------------------------------------------------------------
// parsePrNumber / parseGithubPrUrl unit tests
// ---------------------------------------------------------------------------

describe("parsePrNumber", () => {
  test("extracts number from canonical GitHub PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/123")).toBe(123);
  });

  test("extracts number from URL with query string", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42?foo=bar")).toBe(42);
  });

  test("returns undefined for non-PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/issues/123")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parsePrNumber("")).toBeUndefined();
  });

  test("returns undefined for URL with no number", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/")).toBeUndefined();
  });
});

describe("parseGithubPrUrl", () => {
  test("extracts owner, repo, prNumber from canonical URL", () => {
    expect(parseGithubPrUrl("https://github.com/edobry/minsky/pull/42")).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 42,
    });
  });

  test("accepts http scheme", () => {
    expect(parseGithubPrUrl("http://github.com/owner/repo/pull/1")).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: 1,
    });
  });

  test("ignores query string after pr number", () => {
    expect(parseGithubPrUrl("https://github.com/owner/repo/pull/7?diff=split")).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: 7,
    });
  });

  test("returns undefined for non-github host", () => {
    expect(parseGithubPrUrl("https://gitlab.com/owner/repo/pull/1")).toBeUndefined();
  });

  test("returns undefined for issues URL", () => {
    expect(parseGithubPrUrl("https://github.com/owner/repo/issues/1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fileQualityReviewAsk writer tests
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-id";
const TASK_ID = "mt#1384";
const PR_URL = "https://github.com/owner/repo/pull/99";
const CANONICAL_REF = "github-pr:owner/repo/99";

describe("fileQualityReviewAsk", () => {
  let fakeAskRepo: FakeAskRepository;

  beforeEach(() => {
    fakeAskRepo = new FakeAskRepository();
  });

  test("writes contextRef.ref in canonical github-pr:<owner>/<repo>/<n> form", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: PR_URL,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      body: "PR body text",
    });

    expect(fakeAskRepo.all).toHaveLength(1);
    const ask = fakeAskRepo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    const ref = ask.contextRefs?.[0];
    expect(ref).toBeDefined();
    if (!ref) return;
    expect(ref.kind).toBe("github-pr");
    expect(ref.ref).toBe(CANONICAL_REF);
  });

  test("preserves the full PR URL in the contextRef description", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: PR_URL,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
    });

    const ref = fakeAskRepo.all[0]?.contextRefs?.[0];
    expect(ref?.description).toContain(PR_URL);
    expect(ref?.description).toBe("PR #99 (https://github.com/owner/repo/pull/99)");
  });

  test("populates Ask fields from inputs", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: PR_URL,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      body: "Please look at this",
    });

    const ask = fakeAskRepo.all[0];
    expect(ask).toBeDefined();
    if (!ask) return;

    expect(ask.kind).toBe("quality.review");
    expect(ask.classifierVersion).toBe("v1.0.0");
    expect(ask.requestor).toBe(SESSION_ID);
    expect(ask.parentSessionId).toBe(SESSION_ID);
    expect(ask.parentTaskId).toBe(TASK_ID);
    expect(ask.title).toBe("Review PR #99");
    expect(ask.question).toBe("Please look at this");
    expect(ask.state).toBe("detected");
  });

  test("falls back to default question when body is omitted", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: PR_URL,
      sessionId: SESSION_ID,
    });

    expect(fakeAskRepo.all[0]?.question).toBe("Review the changes in this PR.");
  });

  test("emits empty contextRefs when prUrl is omitted", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      sessionId: SESSION_ID,
    });

    expect(fakeAskRepo.all[0]?.contextRefs).toEqual([]);
  });

  test("emits empty contextRefs when prUrl is unparseable", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: "not-a-github-url",
      sessionId: SESSION_ID,
    });

    expect(fakeAskRepo.all[0]?.contextRefs).toEqual([]);
    expect(fakeAskRepo.all[0]?.title).toBe("Review PR");
  });

  test("uses fallback requestor when sessionId is omitted", async () => {
    await fileQualityReviewAsk(fakeAskRepo, {
      prUrl: PR_URL,
    });

    expect(fakeAskRepo.all[0]?.requestor).toBe("minsky.session:unknown");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: writer + reconciler integration
// ---------------------------------------------------------------------------

/**
 * Spy implementation of OperatorNotify that records calls without side effects.
 */
class SpyOperatorNotify implements OperatorNotify {
  bellCalls = 0;
  notifyCalls: Array<{ title: string; body: string }> = [];

  bell(): void {
    this.bellCalls += 1;
  }

  notify(title: string, body: string): void {
    this.notifyCalls.push({ title, body });
  }
}

/**
 * Fake GithubReviewClient that returns a configurable set of reviews,
 * keyed by `${owner}/${repo}/${prNumber}`.
 */
class FakeGithubReviewClient implements GithubReviewClient {
  private readonly reviewsByPr = new Map<string, GithubReview[]>();

  setReviews(owner: string, repo: string, prNumber: number, reviews: GithubReview[]): void {
    this.reviewsByPr.set(`${owner}/${repo}/${prNumber}`, reviews);
  }

  async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
    return this.reviewsByPr.get(`${owner}/${repo}/${prNumber}`) ?? [];
  }
}

describe("session_pr_create → reconcile end-to-end", () => {
  test("Ask filed via fileQualityReviewAsk transitions to responded and notifies", async () => {
    const askRepo = new FakeAskRepository();
    const githubClient = new FakeGithubReviewClient();
    const notify = new SpyOperatorNotify();

    // 1. File the Ask via the same code path session_pr_create uses.
    await fileQualityReviewAsk(askRepo, {
      prUrl: PR_URL,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      body: "Please review",
    });

    expect(askRepo.all).toHaveLength(1);
    const seededAsk = askRepo.all[0];
    expect(seededAsk).toBeDefined();
    if (!seededAsk) return;
    expect(seededAsk.state).toBe("detected");
    expect(seededAsk.contextRefs?.[0]?.ref).toBe(CANONICAL_REF);

    // 2. Stage a new review on the PR.
    githubClient.setReviews("owner", "repo", 99, [
      {
        reviewId: 1001,
        state: "CHANGES_REQUESTED",
        reviewerLogin: "minsky-reviewer[bot]",
        body: "Please address the failing test in foo.test.ts",
      },
    ]);

    // 3. Run reconcile.
    const result = await reconcile(askRepo, githubClient, notify);

    // 4. Assert the Ask transitioned.
    expect(result.inspected).toBe(1);
    expect(result.responded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const finalAsk = askRepo.all[0];
    expect(finalAsk).toBeDefined();
    if (!finalAsk) return;
    expect(finalAsk.state).toBe("responded");
    expect(finalAsk.response).toBeDefined();
    expect(finalAsk.response?.payload).toMatchObject({
      reviewBody: "Please address the failing test in foo.test.ts",
      reviewState: "CHANGES_REQUESTED",
      reviewAuthor: "minsky-reviewer[bot]",
      reviewId: 1001,
      prNumber: 99,
      owner: "owner",
      repo: "repo",
    });

    // 5. Assert notification fired.
    expect(notify.bellCalls).toBe(1);
    expect(notify.notifyCalls).toHaveLength(1);
    expect(notify.notifyCalls[0]?.title).toBe("Minsky: review posted");
    expect(notify.notifyCalls[0]?.body).toContain("PR #99");
    expect(notify.notifyCalls[0]?.body).toContain("Please address the failing test");
  });

  test("regression: Ask with URL-form ref (pre-fix) is silently skipped", async () => {
    // Documents the bug this task fixes: an Ask whose contextRef holds the
    // raw PR URL (instead of the canonical github-pr: form) is invisible to
    // the reconciler. If a future change re-introduces URL-as-ref, this test
    // will fail because the Ask will transition rather than being skipped.
    const askRepo = new FakeAskRepository();
    const githubClient = new FakeGithubReviewClient();
    const notify = new SpyOperatorNotify();

    await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: SESSION_ID,
      parentSessionId: SESSION_ID,
      title: "Review PR #99",
      question: "review",
      contextRefs: [
        {
          kind: "github-pr",
          ref: PR_URL, // raw URL — the buggy form
          description: "PR #99",
        },
      ],
      metadata: {},
    });

    githubClient.setReviews("owner", "repo", 99, [
      {
        reviewId: 1,
        state: "APPROVED",
        reviewerLogin: "alice",
        body: "lgtm",
      },
    ]);

    const result = await reconcile(askRepo, githubClient, notify);
    expect(result.inspected).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.responded).toBe(0);
    expect(notify.bellCalls).toBe(0);
  });
});
