/**
 * L2 of the `concurrent_inflight` ladder (mt#4895 SC1): does `runReview` RETURN
 * the skip when the in-flight marker is denied?
 *
 * ## What this is NOT
 *
 * It is not a test of the marker itself. Whether a second `acquireMarker` on the
 * same key is denied is L1, and it is already covered twice — `inflight-marker.test.ts`
 * against a stateful fake, and `inflight-marker-conflict.testcontainer.integration.test.ts`
 * against a real Postgres exercising the real `ON CONFLICT` semantics. mt#4895's
 * `## Out of scope` says explicitly not to re-test that. So the fake DB here is
 * deliberately minimal: it produces "denied" or "granted" directly, because the
 * question is what `runReview` DOES with that answer, not how the answer is reached.
 *
 * ## Why seams rather than module patching
 *
 * The marker is keyed on `pr.headSha`, which does not exist until
 * `fetchPullRequestContext` returns — so `createOctokit` and the PR fetch
 * necessarily run BEFORE `acquireMarker`, and nothing can reach this branch
 * without getting past them. They are injected through `RunReviewDeps` per
 * ADR-036 §2 rule 2 (a seam addable in one production file with no exported-type
 * change is required; patching is banned at such a site), which is also the shape
 * PR #3563 used one commit earlier for `terminalCheckRunPublisher`.
 *
 * ## The confound this test has to discriminate
 *
 * `runReview` has TWO returns with `status: "skipped"`, and the routing one comes
 * FIRST — `decideRouting` short-circuits a Tier-1 (or Tier-2-disabled) PR before
 * the marker is ever acquired. So asserting `status === "skipped"` alone would pass
 * for entirely the wrong reason. Every assertion below pins `reason`, and the PR
 * body carries the tier-3 marker so routing resolves to `shouldReview: true` and
 * the marker branch is genuinely the one being exercised.
 */

import { describe, test, expect } from "bun:test";
import { runReview, type RunReviewDeps } from "./review-worker";
import type { ReviewerConfig } from "./config";
import type { ReviewerDb } from "./db/client";
import type { PullRequestContext } from "./github-client";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";

const CONCURRENT_INFLIGHT = "concurrent_inflight";
const SKIP_LOG_EVENT = "runReview.skipped_concurrent_inflight";
/** Thrown by the injected app-identity fetcher to halt the negative control the
 *  instant it proves it got past the marker gate — before any model call. */
const PAST_THE_GATE = "reached runReviewBody past the marker gate";

const CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "not-a-real-private-key",
  installationId: 1,
  webhookSecret: "not-a-real-webhook-secret",
  provider: "openai",
  providerApiKey: "not-a-real-api-key",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 0,
  logLevel: "error",
  modelTimeoutMs: 1_000,
  githubTimeoutMs: 1_000,
};

// Tier 3 in the body → resolveTier returns 3 → decideRouting returns
// shouldReview: true. Without this the routing skip fires first and the marker
// is never reached (see the confound note above).
const PR_CONTEXT: PullRequestContext = {
  number: 4895,
  title: "A PR whose review is already in flight",
  body: "<!-- minsky:tier=3 -->",
  owner: "edobry",
  repo: "minsky",
  headOwner: "edobry",
  headRepo: "minsky",
  isForkedPR: false,
  branchName: "task/mt-4895",
  baseBranch: "main",
  diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
  headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  filesChanged: ["a.ts"],
  fileEntries: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1 }],
  changedFilesCount: 1,
};

interface FakeDb {
  db: ReviewerDb;
  /** One entry per `db.execute` — the acquire INSERT, then any release DELETE. */
  executeCalls: number[];
}

/**
 * The subset of `ReviewerDb` that `acquireMarker` / `releaseMarker` touch.
 *
 * `acquireMarker` reads acquisition from the INSERT's `RETURNING id`: a row means
 * acquired, an empty result means a live marker holds the key. It then reads
 * `heldBy` through a `select().from().where().limit()` chain, inside a try/catch.
 */
function makeFakeDb(options: { acquired: boolean; heldBy?: string }): FakeDb {
  const executeCalls: number[] = [];

  const db = {
    execute: async () => {
      executeCalls.push(executeCalls.length);
      // Call 0 is the acquire INSERT ... RETURNING id. Anything after it is the
      // release DELETE, which returns nothing.
      const isAcquireInsert = executeCalls.length === 1;
      return isAcquireInsert && options.acquired ? [{ id: "marker-row-1" }] : [];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (options.heldBy !== undefined ? [{ acquiredBy: options.heldBy }] : []),
        }),
      }),
    }),
  } as unknown as ReviewerDb;

  return { db, executeCalls };
}

function baseDeps(db: ReviewerDb, extra: RunReviewDeps = {}): RunReviewDeps {
  return {
    db,
    octokitFactory: async () => ({}) as Awaited<ReturnType<RunReviewDeps["octokitFactory"] & {}>>,
    prContextFetcher: async () => PR_CONTEXT,
    // mt#2088 writes a skip-path timing row here. Stubbed so the test needs no DB.
    timingRecorder: async () => {},
    ...extra,
  };
}

describe("runReview — concurrent_inflight skip (mt#4895 L2)", () => {
  test("a HELD marker makes runReview return the concurrent_inflight skip", async () => {
    const { db } = makeFakeDb({ acquired: false, heldBy: "sweeper" });
    const captured = captureConsoleLogs();

    let result;
    try {
      result = await runReview(
        CONFIG,
        "edobry",
        "minsky",
        4895,
        "someone-else",
        "delivery-1",
        PR_CONTEXT.headSha,
        baseDeps(db)
      );
    } finally {
      captured.restore();
    }

    expect(result.status).toBe("skipped");
    // Pinned, not incidental: the routing branch also returns status "skipped".
    expect(result.reason).toBe(CONCURRENT_INFLIGHT);
    expect(result.tier).toBe(3);

    // The log is what the L4 script asserts on, so pin its shape here too.
    const logged = findLogEvent(captured.logs, SKIP_LOG_EVENT);
    expect(logged).not.toBeNull();
    expect(logged?.["acquired_by"]).toBe("sweeper");
    expect(logged?.["head_sha"]).toBe(PR_CONTEXT.headSha);
    expect(logged?.["pr_number"]).toBe(4895);
  });

  test("the skip records a skip-path timing row (mt#2088) rather than skipping the write", async () => {
    const { db } = makeFakeDb({ acquired: false, heldBy: "webhook" });
    const timingWrites: unknown[] = [];
    const silenced = captureConsoleLogs();

    try {
      await runReview(
        CONFIG,
        "edobry",
        "minsky",
        4895,
        "someone-else",
        "delivery-2",
        PR_CONTEXT.headSha,
        baseDeps(db, {
          timingRecorder: async (_db, input) => {
            timingWrites.push(input);
          },
        })
      );
    } finally {
      silenced.restore();
    }

    expect(timingWrites).toHaveLength(1);
  });

  test("the skip log carries the delivery id, which is what correlates it to a delivery", async () => {
    // Deliberately NOT an assertion about the `acquiredBy` label computed from the
    // delivery-id prefix: on the denied path the log's `acquired_by` is
    // `markerResult.heldBy` — the label of whoever ALREADY holds the marker — and
    // the computed one is only ever passed INTO acquireMarker, so it is not
    // observable here. What is observable, and what the L4 script correlates on,
    // is the delivery id.
    const { db } = makeFakeDb({ acquired: false, heldBy: "webhook" });
    const captured = captureConsoleLogs();

    try {
      await runReview(
        CONFIG,
        "edobry",
        "minsky",
        4895,
        "someone-else",
        "sweeper-abc",
        PR_CONTEXT.headSha,
        baseDeps(db)
      );
    } finally {
      captured.restore();
    }

    const logged = findLogEvent(captured.logs, SKIP_LOG_EVENT);
    expect(logged?.["delivery_id"]).toBe("sweeper-abc");
  });

  // ── Negative control ────────────────────────────────────────────────────────
  //
  // Without this the suite above cannot distinguish "detected contention" from
  // "always returns the skip" — the fake DB is the only thing deciding, and a
  // test that never sees it say yes has not shown the branch is live.
  //
  // The control stops at `getAppIdentity`, the first call inside `runReviewBody`
  // and therefore strictly AFTER the marker gate. Throwing there proves the gate
  // was passed without letting the review proceed into a model call.
  test("negative control: an AVAILABLE marker does not return the skip — execution passes the gate", async () => {
    const { db, executeCalls } = makeFakeDb({ acquired: true });
    let appIdentityCalls = 0;
    const captured = captureConsoleLogs();

    try {
      const attempt = runReview(
        CONFIG,
        "edobry",
        "minsky",
        4895,
        "someone-else",
        "delivery-3",
        PR_CONTEXT.headSha,
        baseDeps(db, {
          appIdentityFetcher: async () => {
            appIdentityCalls += 1;
            throw new Error(PAST_THE_GATE);
          },
        })
      );

      await expect(attempt).rejects.toThrow(PAST_THE_GATE);
    } finally {
      captured.restore();
    }

    // Reached the first call past the marker branch — so the skip was not taken.
    expect(appIdentityCalls).toBe(1);
    // And nothing logged the skip on this run.
    expect(findLogEvent(captured.logs, SKIP_LOG_EVENT)).toBeNull();
    // The acquire INSERT plus the release DELETE from runReview's finally: the
    // marker was genuinely taken and given back, which is the state the denied
    // cases above are the complement of.
    expect(executeCalls.length).toBe(2);
  });
});
