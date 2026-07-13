/**
 * Unit tests for the finalize stages extracted from runReviewBody (mt#2731).
 *
 * These exercise finalizeReviewSuccess / finalizeReviewError directly over a
 * constructed ReviewRunContext with injected deps (checkRunPublisher,
 * timingRecorder, metricsRecorder) + an injected emitReviewPosted seam — no
 * network, no module mocking (matching the reviewer suite's convention). This
 * is the finalization-path coverage the full runReview integration harness
 * (mt#1263, BLOCKED) still lacks; the extraction created the natural seam.
 */

import { describe, expect, test, mock } from "bun:test";
import {
  finalizeReviewSuccess,
  finalizeReviewError,
  type ReviewRunContext,
  type FinalizeReviewSuccessInput,
} from "./review-finalize";
import type { RunReviewDeps } from "./review-worker";
import type { ReviewerDb } from "./db/client";
import type { ConvergenceMetricInput } from "./metrics";
import type { ReviewTimingInput } from "./review-timing";
import type { PublishCheckRunOptions } from "./check-run-publisher";
import type { ReviewPostedEvent } from "./review-events";
import type { ReviewThread, SubmittedReview } from "./github-client";

const REVIEW: SubmittedReview = {
  id: 42,
  htmlUrl: "https://github.com/edobry/minsky/pull/1234#r42",
};
const REVIEWER_LOGIN = "minsky-reviewer[bot]";
const EMPTY_OUTPUT_REASON = "empty output from model";

/** Build a fresh harness: a ReviewRunContext plus capture arrays for each injected sink. */
function makeHarness(opts?: { db?: boolean }) {
  const checkRunCalls: PublishCheckRunOptions[] = [];
  const timingCalls: ReviewTimingInput[] = [];
  const metricsCalls: ConvergenceMetricInput[] = [];
  const emitCalls: ReviewPostedEvent[] = [];

  const checkRunPublisher = mock(async (o: PublishCheckRunOptions) => {
    checkRunCalls.push(o);
    return undefined;
  });
  const timingRecorder = mock(async (_db: ReviewerDb, i: ReviewTimingInput) => {
    timingCalls.push(i);
  });
  const metricsRecorder = mock(async (_db: ReviewerDb, i: ConvergenceMetricInput) => {
    metricsCalls.push(i);
  });
  const emitReviewPosted = mock(async (ev: ReviewPostedEvent) => {
    emitCalls.push(ev);
  });

  // octokit is only touched by the thread-resolve loop (via resolveThread ->
  // octokit.graphql); a graphql spy lets the guard tests assert invocation.
  const graphql = mock(async () => ({}));

  const deps: RunReviewDeps = {
    db: opts?.db === false ? undefined : ({} as ReviewerDb),
    checkRunPublisher,
    timingRecorder,
    metricsRecorder,
  };

  const ctx: ReviewRunContext = {
    deps,
    octokit: { graphql } as unknown as ReviewRunContext["octokit"],
    owner: "edobry",
    repo: "minsky",
    pr: { number: 1234, headSha: "abc123", branchName: "task/mt-1234" },
    tier: 3,
    prScope: "normal",
    output: { text: "", provider: "openai", model: "gpt-5", toolCalls: [] },
    attempt: "first-attempt-success",
    retryAttempted: false,
    taskSpecFetch: { status: "found", taskId: "mt#1234" },
    priorReviewIngestion: { iterationCount: 1, staleCount: 0, priorBlockingCounts: [2, 1] },
    totalWallClockMs: 100,
    outputToolsActive: true,
    reviewerLogin: REVIEWER_LOGIN,
    emitReviewPosted,
  };

  return {
    ctx,
    graphql,
    checkRunCalls,
    timingCalls,
    metricsCalls,
    emitCalls,
    checkRunPublisher,
    timingRecorder,
    metricsRecorder,
    emitReviewPosted,
  };
}

function makeThread(id: string, firstAuthor: string | null): ReviewThread {
  return {
    id,
    path: "src/foo.ts",
    line: 10,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    comments: [
      { databaseId: 1, author: firstAuthor, body: "b", createdAt: "2026-07-10T00:00:00Z" },
    ],
    truncatedComments: false,
  };
}

function successInput(overrides?: Partial<FinalizeReviewSuccessInput>): FinalizeReviewSuccessInput {
  return {
    review: REVIEW,
    event: "REQUEST_CHANGES",
    blockingCount: 1,
    acknowledgedBody: "",
    checkRunToolCalls: [],
    threadResolves: [],
    reviewThreads: [],
    status: "reviewed",
    reason: "posted",
    ...overrides,
  };
}

describe("finalizeReviewSuccess (mt#2731)", () => {
  test("wires checkRun + convergence persist + timing + emit and returns the reviewed result", async () => {
    const h = makeHarness();
    const result = await finalizeReviewSuccess(h.ctx, successInput());

    // check run: round N+1, current blocking count, no annotations on this input
    expect(h.checkRunCalls).toHaveLength(1);
    expect(h.checkRunCalls[0]).toMatchObject({
      owner: "edobry",
      repo: "minsky",
      headSha: "abc123",
      prNumber: 1234,
      toolCalls: [],
      convergenceState: { roundNumber: 2, blockingCount: 1 },
    });
    // the publisher receives the same octokit instance carried on the context
    expect(h.checkRunCalls[0]?.octokit).toBe(h.ctx.octokit);

    // convergence metric: prior blockers summed (2+1), verdict lowercased
    expect(h.metricsCalls).toHaveLength(1);
    expect(h.metricsCalls[0]).toEqual({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 1234,
      headSha: "abc123",
      iterationIndex: 2,
      priorBlockerCount: 3,
      newBlockerCount: 1,
      acknowledgedAddressedCount: 0,
      headRef: "task/mt-1234",
      verdict: "request_changes",
    });

    // timing: main-path shape (iteration N+1, tool-use flag, provider/model)
    expect(h.timingCalls).toHaveLength(1);
    expect(h.timingCalls[0]).toMatchObject({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 1234,
      headSha: "abc123",
      iterationIndex: 2,
      toolUseActive: true,
      provider: "openai",
      model: "gpt-5",
    });

    // emit pr.review_posted with the posted event + resolved task id
    expect(h.emitCalls).toHaveLength(1);
    expect(h.emitCalls[0]).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 1234,
      reviewerLogin: REVIEWER_LOGIN,
      event: "REQUEST_CHANGES",
      taskId: "mt#1234",
    });

    // returned ReviewResult carries through ctx + input fields
    expect(result).toMatchObject({
      status: "reviewed",
      review: REVIEW,
      reason: "posted",
      tier: 3,
      providerUsed: "openai",
      providerModel: "gpt-5",
      attempt: "first-attempt-success",
      retryAttempted: false,
      scope: "normal",
      blockingCount: 1,
    });
    expect(result.priorReviewIngestion).toBe(h.ctx.priorReviewIngestion);
  });

  test("lowercases the posted event into the persisted verdict", async () => {
    const h = makeHarness();
    await finalizeReviewSuccess(h.ctx, successInput({ event: "APPROVE" }));
    expect(h.metricsCalls[0]?.verdict).toBe("approve");
    expect(h.emitCalls[0]?.event).toBe("APPROVE");
  });

  test("skips the DB writes (metric + timing) when no db is configured but still posts + emits", async () => {
    const h = makeHarness({ db: false });
    const result = await finalizeReviewSuccess(h.ctx, successInput());
    expect(h.metricsCalls).toHaveLength(0);
    expect(h.timingCalls).toHaveLength(0);
    expect(h.checkRunCalls).toHaveLength(1);
    expect(h.emitCalls).toHaveLength(1);
    expect(result.status).toBe("reviewed");
  });

  test("passes through the output-tools status/reason and check-run annotations verbatim", async () => {
    const h = makeHarness();
    const toolCalls = [
      { name: "submit_finding", args: { severity: "BLOCKING" } },
    ] as unknown as FinalizeReviewSuccessInput["checkRunToolCalls"];
    const result = await finalizeReviewSuccess(
      h.ctx,
      successInput({
        event: "COMMENT",
        blockingCount: 0,
        checkRunToolCalls: toolCalls,
        status: "reviewed",
        reason: "Posted COMMENT review [output-tools]",
      })
    );
    expect(h.checkRunCalls[0]?.toolCalls).toBe(toolCalls);
    expect(h.checkRunCalls[0]?.convergenceState).toEqual({ roundNumber: 2, blockingCount: 0 });
    expect(result.reason).toBe("Posted COMMENT review [output-tools]");
  });

  describe("thread-resolve human-thread guard", () => {
    test("does NOT resolve a thread whose first comment is not from the reviewer bot", async () => {
      const h = makeHarness();
      await finalizeReviewSuccess(
        h.ctx,
        successInput({
          threadResolves: [{ threadId: "t1", reason: "fixed" }],
          reviewThreads: [makeThread("t1", "some-human")],
        })
      );
      expect(h.graphql).toHaveBeenCalledTimes(0);
    });

    test("resolves a thread whose first comment is from the reviewer bot", async () => {
      const h = makeHarness();
      await finalizeReviewSuccess(
        h.ctx,
        successInput({
          threadResolves: [{ threadId: "t1", reason: "fixed" }],
          reviewThreads: [makeThread("t1", REVIEWER_LOGIN)],
        })
      );
      expect(h.graphql).toHaveBeenCalledTimes(1);
    });
  });
});

describe("finalizeReviewError (mt#2731)", () => {
  test("writes timing, posts a liveness-failure check run, returns the error result, and does NOT emit", async () => {
    const h = makeHarness();
    const result = await finalizeReviewError(h.ctx, EMPTY_OUTPUT_REASON);

    expect(h.timingCalls).toHaveLength(1);
    expect(h.timingCalls[0]).toMatchObject({
      prNumber: 1234,
      iterationIndex: 2,
      provider: "openai",
    });

    expect(h.checkRunCalls).toHaveLength(1);
    expect(h.checkRunCalls[0]).toMatchObject({
      headSha: "abc123",
      prNumber: 1234,
      toolCalls: [],
      convergenceState: { roundNumber: 2, blockingCount: 0 },
      failureSummary: EMPTY_OUTPUT_REASON,
    });

    // error path never emits pr.review_posted and never persists a convergence metric
    expect(h.emitCalls).toHaveLength(0);
    expect(h.metricsCalls).toHaveLength(0);

    expect(result).toMatchObject({
      status: "error",
      reason: EMPTY_OUTPUT_REASON,
      tier: 3,
      providerUsed: "openai",
      providerModel: "gpt-5",
      scope: "normal",
    });
    // error results carry no blockingCount
    expect(result.blockingCount).toBeUndefined();
  });

  test("skips the timing write when no db is configured but still posts the failure check run", async () => {
    const h = makeHarness({ db: false });
    await finalizeReviewError(h.ctx, "boom");
    expect(h.timingCalls).toHaveLength(0);
    expect(h.checkRunCalls).toHaveLength(1);
    expect(h.checkRunCalls[0]?.failureSummary).toBe("boom");
  });
});
