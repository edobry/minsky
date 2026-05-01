/**
 * Tests for the wake-signal dispatch path (mt#1481).
 *
 * Covers:
 *   1. dispatchWake() unit tests — payload construction, missing-parentSessionId skip
 *   2. reconcile() integration tests — wake fires alongside operator-notify, skips
 *      cleanly when parentSessionId is absent, default sink doesn't break legacy
 *      three-arg callers (regression for PR #858 / mt#1384's integration test)
 *
 * All tests are hermetic: no real DB, no real GitHub API, no real notify.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import { reconcile, type GithubReview, type GithubReviewClient } from "./reconciler";
import type { OperatorNotify } from "../notify/operator-notify";
import {
  dispatchWake,
  LoggingWakeSignalSink,
  type WakeSignalPayload,
  type WakeSignalSink,
} from "./wake-on-respond";

// ---------------------------------------------------------------------------
// Shared constants — avoid magic-string duplication.
// ---------------------------------------------------------------------------

const REVIEWER_LOGIN = "minsky-reviewer[bot]";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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

class SpyWakeSink implements WakeSignalSink {
  signals: WakeSignalPayload[] = [];
  emit(signal: WakeSignalPayload): void {
    this.signals.push(signal);
  }
}

class FakeGithubReviewClient implements GithubReviewClient {
  private readonly reviewsByPr = new Map<string, GithubReview[]>();

  setReviews(owner: string, repo: string, prNumber: number, reviews: GithubReview[]): void {
    this.reviewsByPr.set(`${owner}/${repo}/${prNumber}`, reviews);
  }

  async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
    return this.reviewsByPr.get(`${owner}/${repo}/${prNumber}`) ?? [];
  }
}

// ---------------------------------------------------------------------------
// dispatchWake — unit tests
// ---------------------------------------------------------------------------

describe("dispatchWake", () => {
  test("emits exactly one signal with the expected payload when parentSessionId is set", async () => {
    const sink = new SpyWakeSink();

    await dispatchWake(sink, {
      askId: "ask-1",
      parentSessionId: "session-uuid-1",
      parentTaskId: "mt#999",
      reviewBody: "Looks good",
      reviewState: "APPROVED",
      reviewAuthor: REVIEWER_LOGIN,
      prNumber: 42,
    });

    expect(sink.signals).toHaveLength(1);
    expect(sink.signals[0]).toEqual({
      askId: "ask-1",
      parentSessionId: "session-uuid-1",
      parentTaskId: "mt#999",
      reviewBody: "Looks good",
      reviewState: "APPROVED",
      reviewAuthor: REVIEWER_LOGIN,
      prNumber: 42,
    });
  });

  test("skips emission when parentSessionId is undefined", async () => {
    const sink = new SpyWakeSink();

    await dispatchWake(sink, {
      askId: "ask-2",
      parentSessionId: undefined,
      parentTaskId: "mt#999",
      reviewBody: "x",
      reviewState: "APPROVED",
      reviewAuthor: "alice",
      prNumber: 99,
    });

    expect(sink.signals).toHaveLength(0);
  });

  test("skips emission when parentSessionId is the empty string", async () => {
    const sink = new SpyWakeSink();

    await dispatchWake(sink, {
      askId: "ask-3",
      parentSessionId: "",
      parentTaskId: "mt#999",
      reviewBody: "x",
      reviewState: "APPROVED",
      reviewAuthor: "alice",
      prNumber: 99,
    });

    expect(sink.signals).toHaveLength(0);
  });

  test("preserves null reviewAuthor through to payload", async () => {
    const sink = new SpyWakeSink();

    await dispatchWake(sink, {
      askId: "ask-4",
      parentSessionId: "session-uuid-4",
      parentTaskId: undefined,
      reviewBody: "anonymous review",
      reviewState: "COMMENTED",
      reviewAuthor: null,
      prNumber: 1,
    });

    expect(sink.signals).toHaveLength(1);
    expect(sink.signals[0]?.reviewAuthor).toBeNull();
    expect(sink.signals[0]?.parentTaskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reconcile() integration — wake path
// ---------------------------------------------------------------------------

describe("reconcile -> wake integration (mt#1481)", () => {
  let askRepo: FakeAskRepository;
  let githubClient: FakeGithubReviewClient;
  let notify: SpyOperatorNotify;
  let wakeSink: SpyWakeSink;

  beforeEach(() => {
    askRepo = new FakeAskRepository();
    githubClient = new FakeGithubReviewClient();
    notify = new SpyOperatorNotify();
    wakeSink = new SpyWakeSink();
  });

  // Acceptance test #1 from spec: parentSessionId present.
  test("Ask with parentSessionId fires wake AND existing operator-notify", async () => {
    const ask = await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: "minsky.session:session-1",
      parentSessionId: "session-1",
      parentTaskId: "mt#1481",
      title: "Review PR #99",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/99", description: "PR #99" }],
      metadata: {},
    });

    githubClient.setReviews("owner", "repo", 99, [
      {
        reviewId: 1001,
        state: "CHANGES_REQUESTED",
        reviewerLogin: REVIEWER_LOGIN,
        body: "Please address the failing test",
      },
    ]);

    const result = await reconcile(askRepo, githubClient, notify, wakeSink);

    // Ask transitioned to responded.
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);
    const finalAsk = await askRepo.getById(ask.id);
    expect(finalAsk?.state).toBe("responded");

    // Wake signal fired exactly once with the full mt#1481 payload shape.
    expect(wakeSink.signals).toHaveLength(1);
    expect(wakeSink.signals[0]).toEqual({
      askId: ask.id,
      parentSessionId: "session-1",
      parentTaskId: "mt#1481",
      reviewBody: "Please address the failing test",
      reviewState: "CHANGES_REQUESTED",
      reviewAuthor: REVIEWER_LOGIN,
      prNumber: 99,
    });

    // Existing operator-notify still fires — wake is parallel, NOT replacement.
    expect(notify.bellCalls).toBe(1);
    expect(notify.notifyCalls).toHaveLength(1);
    expect(notify.notifyCalls[0]?.title).toBe("Minsky: review posted");
  });

  // Acceptance test #2 from spec: parentSessionId missing.
  test("Ask without parentSessionId skips wake but still transitions and notifies", async () => {
    const ask = await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: "minsky.session:session-2",
      // parentSessionId omitted intentionally.
      parentTaskId: "mt#1481",
      title: "Review PR #100",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/100", description: "PR #100" }],
      metadata: {},
    });

    githubClient.setReviews("owner", "repo", 100, [
      {
        reviewId: 1002,
        state: "APPROVED",
        reviewerLogin: "alice",
        body: "lgtm",
      },
    ]);

    const result = await reconcile(askRepo, githubClient, notify, wakeSink);

    // Ask still transitions to responded.
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);
    const finalAsk = await askRepo.getById(ask.id);
    expect(finalAsk?.state).toBe("responded");

    // Wake signal NOT fired — no addressable target.
    expect(wakeSink.signals).toHaveLength(0);

    // Existing operator-notify still fires.
    expect(notify.bellCalls).toBe(1);
    expect(notify.notifyCalls).toHaveLength(1);
  });

  // Acceptance test #3 from spec: regression — pre-existing 3-arg callers
  // (e.g., asks.ts MCP wiring, PR #858's integration test) keep working
  // because wakeSink defaults to a LoggingWakeSignalSink.
  test("default sink keeps 3-arg callers unbroken (regression)", async () => {
    await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: "minsky.session:session-3",
      parentSessionId: "session-3",
      parentTaskId: "mt#1481",
      title: "Review PR #101",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/101", description: "PR #101" }],
      metadata: {},
    });

    githubClient.setReviews("owner", "repo", 101, [
      {
        reviewId: 1003,
        state: "APPROVED",
        reviewerLogin: "bob",
        body: "ok",
      },
    ]);

    // Three-arg form: no wakeSink supplied. Default LoggingWakeSignalSink takes over.
    // The contract is that this does NOT throw and existing notify still fires.
    const result = await reconcile(askRepo, githubClient, notify);
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);
    expect(notify.bellCalls).toBe(1);
  });

  test("sink failure does NOT roll back respond() and does NOT short-circuit notify", async () => {
    const askA = await askRepo.create({
      kind: "quality.review",
      classifierVersion: "v1.0.0",
      requestor: "minsky.session:session-x",
      parentSessionId: "session-x",
      parentTaskId: "mt#1481",
      title: "Review PR #200",
      question: "review",
      contextRefs: [{ kind: "github-pr", ref: "github-pr:owner/repo/200", description: "PR #200" }],
      metadata: {},
    });

    githubClient.setReviews("owner", "repo", 200, [
      {
        reviewId: 2001,
        state: "APPROVED",
        reviewerLogin: "carol",
        body: "approve",
      },
    ]);

    const throwingSink: WakeSignalSink = {
      emit() {
        throw new Error("simulated sink failure");
      },
    };

    const result = await reconcile(askRepo, githubClient, notify, throwingSink);

    // Despite the sink throwing, the Ask still transitions and notify still fires.
    expect(result.responded).toBe(1);
    expect(result.errors).toBe(0);
    const finalAsk = await askRepo.getById(askA.id);
    expect(finalAsk?.state).toBe("responded");
    expect(notify.bellCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LoggingWakeSignalSink — smoke
// ---------------------------------------------------------------------------

describe("LoggingWakeSignalSink", () => {
  test("does not throw on emit", () => {
    const sink = new LoggingWakeSignalSink();
    expect(() =>
      sink.emit({
        askId: "ask-x",
        parentSessionId: "session-x",
        parentTaskId: "mt#1481",
        reviewBody: "x",
        reviewState: "APPROVED",
        reviewAuthor: "alice",
        prNumber: 1,
      })
    ).not.toThrow();
  });

  // Regression: PR #923 review rounds 1 and 2 caught two related issues:
  //   R1: structured `event` field mismatched the documented filter contract
  //   R2: `log.info` is no-op in default HUMAN mode — wake events were silently
  //       dropped, breaking the operator-tail contract entirely.
  // Fix: route through `log.cli` (program logger, always emits) with the JSON
  // payload embedded in the message, prefixed with the literal tag `ask.wake`.
  // This test pins both the channel and the field contract so future drift
  // breaks here, not in production logs.
  test("emits via cli channel with ask.wake tag and full payload JSON", () => {
    const cliCalls: string[] = [];
    const cliWarnCalls: string[] = [];
    const recordingLogger = {
      cli(message: unknown): void {
        cliCalls.push(String(message));
      },
      cliWarn(message: unknown): void {
        cliWarnCalls.push(String(message));
      },
    };

    const sink = new LoggingWakeSignalSink(recordingLogger);

    sink.emit({
      askId: "ask-1",
      parentSessionId: "session-1",
      parentTaskId: "mt#1481",
      reviewBody: "review body",
      reviewState: "APPROVED",
      reviewAuthor: REVIEWER_LOGIN,
      prNumber: 99,
    });

    // Channel contract: emitted via cli (program-logger info, always emits),
    // not via cliWarn or any other channel.
    expect(cliCalls).toHaveLength(1);
    expect(cliWarnCalls).toHaveLength(0);

    const line = cliCalls[0] ?? "";

    // Line-prefix contract: `ask.wake ` (tag + single space) so operators can
    // grep `^ask\.wake ` to filter the success channel from the skipped channel.
    expect(line.startsWith("ask.wake ")).toBe(true);
    expect(line.startsWith("ask.wake.skipped")).toBe(false);

    // Field contract: parse the JSON suffix and assert every documented field.
    const jsonStart = line.indexOf("{");
    expect(jsonStart).toBeGreaterThan(0);
    const fields = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;

    // Documented operator-filter contract: event=ask.wake.
    expect(fields.event).toBe("ask.wake");
    // The cause field identifies the upstream transition (one of N triggers
    // we may add later).
    expect(fields.cause).toBe("quality.review.responded");
    // All seven payload fields are present.
    expect(fields.askId).toBe("ask-1");
    expect(fields.parentSessionId).toBe("session-1");
    expect(fields.parentTaskId).toBe("mt#1481");
    expect(fields.reviewBody).toBe("review body");
    expect(fields.reviewState).toBe("APPROVED");
    expect(fields.reviewAuthor).toBe(REVIEWER_LOGIN);
    expect(fields.prNumber).toBe(99);
  });
});
