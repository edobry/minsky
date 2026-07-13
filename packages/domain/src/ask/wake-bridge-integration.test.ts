/**
 * End-to-end integration test for the mt#1661 v0 wake-signal bridge.
 *
 * Exercises the full babysit-PR loop:
 *   1. File a quality.review Ask with parentSessionId = S
 *   2. Reconciler detects review and transitions Ask suspended → responded
 *   3. CompositeWakeSignalSink fires both LoggingWakeSignalSink and
 *      PersistentWakeSignalSink — the persistent sink writes a row to the
 *      fake wake_pending repo
 *   4. enrichWakeResponse middleware on a subsequent allowlisted MCP tool call
 *      (with args.session = S) drains the row and returns a content block
 *   5. Idempotency: a second tool call returns null
 *
 * All test doubles are fakes; no real DB, no real GitHub API, no real notify.
 *
 * Reference: mt#1519 §6 (worked example), mt#1661 spec §Acceptance Tests #5.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import { reconcile, type GithubReview, type GithubReviewClient } from "./reconciler";
import type { OperatorNotify } from "../notify/operator-notify";
import {
  CompositeWakeSignalSink,
  LoggingWakeSignalSink,
  PersistentWakeSignalSink,
} from "./wake-on-respond";
import { FakeWakePendingRepository } from "./wake-pending-repository";
import {
  enrichWakeResponse,
  type SessionResolver,
} from "../../../../src/mcp/middleware/wake-enrichment";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class StubOperatorNotify implements OperatorNotify {
  bell(): void {}
  notify(): void {}
}

class FakeGithubReviewClient implements GithubReviewClient {
  private reviews = new Map<string, GithubReview[]>();

  setReviews(owner: string, repo: string, prNumber: number, reviews: GithubReview[]): void {
    this.reviews.set(`${owner}/${repo}#${prNumber}`, reviews);
  }

  async listReviews(
    owner: string,
    repo: string,
    prNumber: number,
    _opts?: { afterReviewId?: number }
  ): Promise<GithubReview[]> {
    return this.reviews.get(`${owner}/${repo}#${prNumber}`) ?? [];
  }
}

const REVIEWER_LOGIN = "minsky-reviewer[bot]";
const ALLOWLISTED_TOOL = "tasks.get";

// ---------------------------------------------------------------------------
// Babysit-PR end-to-end
// ---------------------------------------------------------------------------

describe("wake bridge end-to-end (mt#1661 v0 babysit-PR loop)", () => {
  let askRepo: FakeAskRepository;
  let wakeRepo: FakeWakePendingRepository;
  let githubClient: FakeGithubReviewClient;
  let operatorNotify: StubOperatorNotify;
  let resolver: SessionResolver;
  const SESSION_ID = "session-babysit";

  beforeEach(() => {
    askRepo = new FakeAskRepository();
    wakeRepo = new FakeWakePendingRepository();
    githubClient = new FakeGithubReviewClient();
    operatorNotify = new StubOperatorNotify();
    resolver = {
      async resolveParentSessionId(args: Record<string, unknown>): Promise<string | null> {
        if (typeof args.session === "string") return args.session;
        if (typeof args.sessionId === "string") return args.sessionId;
        return null;
      },
    };
  });

  test("review-posted Ask response delivers wake on next allowlisted tool call", async () => {
    // 1. Implementer files a quality.review Ask bound to session S.
    const ask = await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: `minsky.session:${SESSION_ID}`,
      parentSessionId: SESSION_ID,
      parentTaskId: "mt#1661",
      title: "Review PR #200",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/200", description: "PR #200" }],
      metadata: {},
    });

    // 2. Reviewer-bot posts a review (modeled by GitHub fixture).
    githubClient.setReviews("owner", "repo", 200, [
      {
        reviewId: 9001,
        state: "CHANGES_REQUESTED",
        reviewerLogin: REVIEWER_LOGIN,
        body: "fix the failing assertion",
      },
    ]);

    // 3. Reconciler runs with the production composite sink shape.
    const compositeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(),
      new PersistentWakeSignalSink(wakeRepo),
    ]);
    const result = await reconcile(askRepo, githubClient, operatorNotify, compositeSink);
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);

    // Wake row landed in the persistent repo, undelivered.
    const beforeDrain = wakeRepo.listAll();
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.parentSessionId).toBe(SESSION_ID);
    expect(beforeDrain[0]?.drainedAt).toBeNull();

    // 4. Implementer's next MCP tool call (carrying session arg) drains the wake.
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: SESSION_ID },
      wakeRepo,
      resolver
    );

    expect(block).not.toBeNull();
    expect(block?.text).toContain(`session="${SESSION_ID}"`);
    expect(block?.text).toContain('"reviewState":"CHANGES_REQUESTED"');
    expect(block?.text).toContain('"reviewBody":"fix the failing assertion"');
    expect(block?.text).toContain(`"askId":"${ask.id}"`);

    // Row is marked drained for the calling tool.
    const afterDrain = wakeRepo.listAll();
    expect(afterDrain[0]?.drainedAt).not.toBeNull();
    expect(afterDrain[0]?.drainedForTool).toBe(ALLOWLISTED_TOOL);

    // 5. Idempotency: a second tool call returns null (no re-delivery).
    const second = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: SESSION_ID },
      wakeRepo,
      resolver
    );
    expect(second).toBeNull();
  });

  test("tool call with no session arg falls into v0 inadequacy class", async () => {
    // File + reconcile → wake row exists.
    await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: `minsky.session:${SESSION_ID}`,
      parentSessionId: SESSION_ID,
      parentTaskId: "mt#1661",
      title: "Review PR #201",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/201", description: "PR #201" }],
      metadata: {},
    });
    githubClient.setReviews("owner", "repo", 201, [
      {
        reviewId: 9002,
        state: "APPROVED",
        reviewerLogin: REVIEWER_LOGIN,
        body: "ok",
      },
    ]);
    const compositeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(),
      new PersistentWakeSignalSink(wakeRepo),
    ]);
    await reconcile(askRepo, githubClient, operatorNotify, compositeSink);
    expect(wakeRepo.listAll()).toHaveLength(1);

    // Tool call with no session/sessionId/task arg: resolver returns null,
    // middleware returns null, the wake row stays undelivered.
    const block = await enrichWakeResponse(ALLOWLISTED_TOOL, {}, wakeRepo, resolver);
    expect(block).toBeNull();
    expect(wakeRepo.listAll()[0]?.drainedAt).toBeNull();
  });
});
