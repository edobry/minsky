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
import type { ChangedFilesFetcherFn } from "./resolution-classifier";

const REVIEW: SubmittedReview = {
  id: 42,
  htmlUrl: "https://github.com/edobry/minsky/pull/1234#r42",
};
const REVIEWER_LOGIN = "minsky-reviewer[bot]";

/**
 * mt#4556: the configuration arm carried on the per-review context. Asserted
 * below to reach the timing row unchanged — `writeMainPathTiming` must stamp
 * what the context carries, not re-derive it.
 */
const CTX_FINGERPRINT = "v1;effort=low;model=gpt-5;provider=openai;tier2=off";
const EMPTY_OUTPUT_REASON = "empty output from model";

/**
 * Shared alias for the checkRunToolCalls field type — referencing this via an
 * identifier (instead of repeating `FinalizeReviewSuccessInput["checkRunToolCalls"]`'s
 * indexed-access string literal at every synthetic-tool-calls call site) avoids
 * custom/no-magic-string-duplication warnings on the repeated literal.
 */
type CheckRunToolCalls = FinalizeReviewSuccessInput["checkRunToolCalls"];

/**
 * A db double that actually implements insert/update/select (unlike the `{}`
 * stub used by the rest of this harness) so the mt#3295/mt#3300
 * findings-persistence assertions below can observe what recordFindings /
 * classifyOutstandingFindings actually write, rather than only confirming
 * the swallow-on-error path (which `{}` exercises implicitly).
 *
 * `outstandingRows` seeds the rows `classifyOutstandingFindings`'s `select`
 * query returns — the still-open prior BLOCKING findings a test wants
 * classified. Defaults to `[]` (no prior findings — the pre-mt#3300
 * no-op case).
 */
function makeFindingsTrackingDb(opts?: {
  outstandingRows?: Array<{ id: string; file: string; headSha: string }>;
}) {
  const insertedRows: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const outstandingRows = opts?.outstandingRows ?? [];
  const db = {
    insert: mock(() => ({
      values: mock((rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
        return { onConflictDoNothing: mock(() => Promise.resolve()) };
      }),
    })),
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve(outstandingRows)),
      })),
    })),
  } as unknown as ReviewerDb;
  return { db, insertedRows, updateSets };
}

/** Build a fresh harness: a ReviewRunContext plus capture arrays for each injected sink. */
function makeHarness(opts?: {
  db?: boolean;
  trackingDb?: ReviewerDb;
  outputToolsActive?: boolean;
  changedFilesFetcher?: ChangedFilesFetcherFn;
  /**
   * mt#3300 PR #2394 R1 BLOCKING #2: a real-shaped `octokit.rest.repos.compareCommits`
   * spy, for the end-to-end wiring test that exercises the DEFAULT
   * `changedFilesFetcher` closure (built in review-finalize.ts from
   * `fetchChangedFilesSince`) instead of an injected seam — a seam-only test
   * would never catch an argument-binding bug in that closure.
   */
  compareCommits?: ReturnType<typeof mock>;
}) {
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

  // octokit is touched by the thread-resolve loop (via resolveThread ->
  // octokit.graphql) and, when no changedFilesFetcher seam is injected, by
  // the default classifier fetcher (via octokit.rest.repos.compareCommits).
  const graphql = mock(async () => ({}));
  const compareCommits =
    opts?.compareCommits ??
    mock(async () => {
      throw new Error("no rest.repos.compareCommits stub configured for this test");
    });

  const resolvedDb = opts?.db === false ? undefined : (opts?.trackingDb ?? ({} as ReviewerDb));

  const deps: RunReviewDeps = {
    db: resolvedDb,
    checkRunPublisher,
    timingRecorder,
    metricsRecorder,
    ...(opts?.changedFilesFetcher ? { changedFilesFetcher: opts.changedFilesFetcher } : {}),
  };

  const ctx: ReviewRunContext = {
    deps,
    octokit: {
      graphql,
      rest: { repos: { compareCommits } },
    } as unknown as ReviewRunContext["octokit"],
    owner: "edobry",
    repo: "minsky",
    pr: { number: 1234, headSha: "abc123", branchName: "task/mt-1234" },
    tier: 3,
    prScope: "normal",
    output: { text: "", provider: "openai", model: "gpt-5", toolCalls: [] },
    attempt: "first-attempt-success",
    retryAttempted: false,
    priorReviewIngestion: { iterationCount: 1, staleCount: 0, priorBlockingCounts: [2, 1] },
    totalWallClockMs: 100,
    outputToolsActive: opts?.outputToolsActive ?? true,
    configFingerprint: CTX_FINGERPRINT,
    reviewerLogin: REVIEWER_LOGIN,
    emitReviewPosted,
    taskSpecFetch: { status: "found", taskId: "mt#1234" },
  };

  return {
    ctx,
    graphql,
    compareCommits,
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
      // mt#4556 AT5: the main (model-invoking) write site stamps the arm the
      // per-review context carries. Asserted as an exact value, not merely
      // non-null, because `writeMainPathTiming` must pass the context's
      // fingerprint through rather than re-deriving one from ambient env.
      configFingerprint: CTX_FINGERPRINT,
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
    ] as unknown as CheckRunToolCalls;
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

  describe("mt#3295 findings persistence", () => {
    test("persists this round's findings from checkRunToolCalls on the output-tools path", async () => {
      const { db, insertedRows } = makeFindingsTrackingDb();
      const h = makeHarness({ trackingDb: db, outputToolsActive: true });
      const toolCalls = [
        {
          name: "submit_finding",
          args: {
            severity: "BLOCKING",
            file: "src/foo.ts",
            line: 10,
            summary: "One-sentence summary",
            details: "Full explanation",
          },
        },
      ] as unknown as CheckRunToolCalls;

      await finalizeReviewSuccess(h.ctx, successInput({ checkRunToolCalls: toolCalls }));

      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({
        prOwner: "edobry",
        prRepo: "minsky",
        prNumber: 1234,
        headSha: "abc123",
        round: 2, // iterationIndex = priorReviewIngestion.iterationCount + 1
        severity: "BLOCKING",
        file: "src/foo.ts",
        line: 10,
        title: "One-sentence summary",
        body: "Full explanation",
        disposition: null,
      });
    });

    test("marks a finding bypassed when its locator is in bypassedFindingLocators", async () => {
      const { db, insertedRows } = makeFindingsTrackingDb();
      const h = makeHarness({ trackingDb: db, outputToolsActive: true });
      const toolCalls = [
        {
          name: "submit_finding",
          args: {
            severity: "NON-BLOCKING", // already downgraded upstream
            file: "src/foo.ts",
            line: 10,
            summary: "s",
            details: "d",
          },
        },
      ] as unknown as CheckRunToolCalls;
      const bypassedFindingLocators = new Set(["src/foo.ts::10::"]);

      await finalizeReviewSuccess(
        h.ctx,
        successInput({ checkRunToolCalls: toolCalls, bypassedFindingLocators })
      );

      expect(insertedRows[0]?.["disposition"]).toBe("bypassed");
    });

    test("falls back to parsing acknowledgedBody when outputToolsActive is false", async () => {
      const { db, insertedRows } = makeFindingsTrackingDb();
      const h = makeHarness({ trackingDb: db, outputToolsActive: false });

      await finalizeReviewSuccess(
        h.ctx,
        successInput({
          checkRunToolCalls: [],
          acknowledgedBody: "**[BLOCKING]** src/bar.ts:20 - Something is wrong.",
        })
      );

      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({
        severity: "BLOCKING",
        file: "src/bar.ts",
        line: 20,
        body: "Something is wrong.",
      });
    });

    test("mt#3300: falls back to disposition=unknown on APPROVE when the diff fetch fails", async () => {
      const { db, updateSets } = makeFindingsTrackingDb({
        outstandingRows: [{ id: "f1", file: "src/foo.ts", headSha: "priorsha1" }],
      });
      const h = makeHarness({ trackingDb: db });
      // No changedFilesFetcher injected: the default production fetcher runs
      // against the harness's bare `{graphql}` octokit double, which has no
      // `.rest.repos.compareCommits` — the fetch fails, and the classifier
      // falls back to the safe "unknown" default (never a guess).

      await finalizeReviewSuccess(h.ctx, successInput({ event: "APPROVE", blockingCount: 0 }));

      expect(updateSets).toHaveLength(1);
      expect(updateSets[0]?.["disposition"]).toBe("unknown");
      expect(updateSets[0]?.["dispositionSetAt"]).toBeInstanceOf(Date);
    });

    test("mt#3300: classifies fixed-by-code-change vs resolved-without-code-change on APPROVE", async () => {
      const { db, updateSets } = makeFindingsTrackingDb({
        outstandingRows: [
          { id: "f-touched", file: "src/touched.ts", headSha: "priorsha1" },
          { id: "f-untouched", file: "src/untouched.ts", headSha: "priorsha1" },
        ],
      });
      const changedFilesFetcher: ChangedFilesFetcherFn = mock(async () => [
        { filename: "src/touched.ts" },
      ]);
      const h = makeHarness({ trackingDb: db, changedFilesFetcher });

      await finalizeReviewSuccess(h.ctx, successInput({ event: "APPROVE", blockingCount: 0 }));

      const dispositions = updateSets.map((s) => s["disposition"]);
      expect(dispositions).toContain("fixed-by-code-change");
      expect(dispositions).toContain("resolved-without-code-change");
      expect(changedFilesFetcher).toHaveBeenCalledWith("priorsha1", "abc123");
    });

    test("mt#3300 R1 BLOCKING #2 — the default changedFilesFetcher binds baseSha/headSha/owner/repo correctly end-to-end", async () => {
      // Deliberately NOT injecting `changedFilesFetcher` into deps — this
      // exercises the REAL default closure `review-finalize.ts` builds from
      // `fetchChangedFilesSince`, not an injected seam. A seam-only test (the
      // two tests above) cannot catch an argument-binding bug in that closure.
      const { db, updateSets } = makeFindingsTrackingDb({
        outstandingRows: [{ id: "f1", file: "src/touched.ts", headSha: "priorsha1" }],
      });
      const compareCommits = mock(async (_params?: Record<string, unknown>) => ({
        data: { files: [{ filename: "src/touched.ts" }] },
      }));
      const h = makeHarness({ trackingDb: db, compareCommits });

      await finalizeReviewSuccess(h.ctx, successInput({ event: "APPROVE", blockingCount: 0 }));

      expect(compareCommits).toHaveBeenCalledTimes(1);
      const call = compareCommits.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).toMatchObject({
        owner: "edobry",
        repo: "minsky",
        base: "priorsha1", // the finding's OWN round headSha (older commit)
        head: "abc123", // ctx.pr.headSha — the APPROVING round's headSha (newer commit)
      });
      expect(updateSets).toHaveLength(1);
      expect(updateSets[0]?.["disposition"]).toBe("fixed-by-code-change");
    });

    test("does NOT resolve outstanding findings on REQUEST_CHANGES", async () => {
      const { db, updateSets } = makeFindingsTrackingDb();
      const h = makeHarness({ trackingDb: db });

      await finalizeReviewSuccess(h.ctx, successInput({ event: "REQUEST_CHANGES" }));

      expect(updateSets).toHaveLength(0);
    });

    test("skips findings persistence entirely when no db is configured", async () => {
      const h = makeHarness({ db: false });
      // Should not throw even though there's no tracking db to observe.
      await expect(
        finalizeReviewSuccess(h.ctx, successInput({ event: "APPROVE" }))
      ).resolves.toBeDefined();
    });
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
