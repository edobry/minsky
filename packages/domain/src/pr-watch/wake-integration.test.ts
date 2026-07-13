/**
 * Wake-integration test — pr_watch firing -> wake_pending -> enrichWakeResponse.
 *
 * Exercises the full mt#1725 path end-to-end against in-memory fakes:
 *
 *   1. Register a watch with parentSessionId = S and event: "review-posted"
 *      via FakePrWatchRepository.
 *   2. Simulate the predicate matching (mock GithubPrClient returns a new review).
 *   3. Run runWatcher with a CompositeWakeSignalSink that includes a
 *      PersistentWakeSignalSink backed by FakeWakePendingRepository.
 *   4. Assert a "pr.watch" row appears in wake_pending keyed on S.
 *   5. Call enrichWakeResponse with an allowlisted tool and args.session = S.
 *   6. Assert the wake-events block appears in the response with the correct payload.
 *
 * Uses only in-memory fakes — no database, no network calls.
 *
 * Reference: mt#1725 spec acceptance test criterion #4.
 */

import { describe, test, expect } from "bun:test";
import { runWatcher, type GithubPrClient, type GithubPrReview } from "./watcher";
import { FakePrWatchRepository } from "./repository";
import { FakeWakePendingRepository } from "../ask/wake-pending-repository";
import {
  CompositeWakeSignalSink,
  LoggingWakeSignalSink,
  PersistentWakeSignalSink,
} from "../ask/wake-on-respond";
import {
  enrichWakeResponse,
  type SessionResolver,
} from "../../../../src/mcp/middleware/wake-enrichment";
import type { OperatorNotify } from "../notify/operator-notify";

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

/** Silent OperatorNotify — does not bell or send notifications in tests. */
const silentNotify: OperatorNotify = {
  bell: () => {},
  notify: (_title: string, _body: string) => {},
};

/** Silent WakeSinkLogger for LoggingWakeSignalSink — prevents test output noise. */
const silentLogger = {
  cli: (_msg: unknown) => {},
  cliWarn: (_msg: unknown) => {},
};

/** Shared watcher identity used across tests — extracted to avoid magic-string duplication. */
const TEST_WATCHER_ID = "operator:local:test";

/**
 * Build a GithubPrClient fake that returns one review with the given ID.
 * All other methods return empty / null.
 */
function fakeClientWithReview(reviewId: number): GithubPrClient {
  const review: GithubPrReview = {
    id: reviewId,
    state: "APPROVED",
    reviewerLogin: "minsky-reviewer[bot]",
  };
  return {
    getPr: async () => ({ merged: false, title: "Test PR" }),
    listReviews: async () => [review],
    listCheckRuns: async () => [],
  };
}

/** SessionResolver that maps any args.session value directly to itself. */
const passthroughResolver: SessionResolver = {
  async resolveParentSessionId(args: Record<string, unknown>): Promise<string | null> {
    const v = args["session"];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pr_watch wake-integration", () => {
  test("fired watch with parentSessionId writes a pr.watch row to wake_pending", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();

    const parentSessionId = "session-abc-123";

    // Step 1: register a watch with parentSessionId
    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 42,
      event: "review-posted",
      keep: false,
      watcherId: TEST_WATCHER_ID,
      parentSessionId,
    });

    // Step 2: build the composite sink (logging-only logger + persistent fake repo)
    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);

    // Step 3: run the watcher with a client that returns a new review
    const githubClient = fakeClientWithReview(1001);
    const result = await runWatcher(prWatchRepo, githubClient, silentNotify, wakeSink);

    // Step 4: assert the watcher fired
    expect(result.fired).toBe(1);
    expect(result.errors).toBe(0);

    // Assert a row appeared in wake_pending keyed on the session
    const allRows = wakePendingRepo.listAll();
    expect(allRows).toHaveLength(1);
    const row = allRows[0];
    if (!row) throw new Error("Expected one wake_pending row");
    expect(row.parentSessionId).toBe(parentSessionId);
    expect(row.payload.kind).toBe("pr.watch");
    expect(row.payload.parentSessionId).toBe(parentSessionId);
    expect(row.payload.reviewState).toBe("review-posted");
    expect(row.payload.prNumber).toBe(42);
    expect(row.drainedAt).toBeNull(); // not yet drained
  });

  test("enrichWakeResponse delivers the wake block when called with matching session", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();

    const parentSessionId = "session-def-456";

    // Register and fire the watch (same as above)
    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 99,
      event: "review-posted",
      keep: false,
      watcherId: TEST_WATCHER_ID,
      parentSessionId,
    });

    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);

    await runWatcher(prWatchRepo, fakeClientWithReview(2001), silentNotify, wakeSink);

    // Step 5: call enrichWakeResponse with an allowlisted tool and the session
    // "tasks.get" is in the allowlist, and args.session maps to parentSessionId
    const block = await enrichWakeResponse(
      "tasks.get",
      { session: parentSessionId },
      wakePendingRepo,
      passthroughResolver
    );

    // Step 6: assert the wake-events block appears with correct payload
    expect(block).not.toBeNull();
    expect(block?.type).toBe("text");
    expect(block?.text).toContain(`<wake-events tool="tasks.get" session="${parentSessionId}"`);
    expect(block?.text).toContain("</wake-events>");
    expect(block?.text).toContain('"kind":"pr.watch"');
    expect(block?.text).toContain('"prNumber":99');
    expect(block?.text).toContain('"reviewState":"review-posted"');

    // Row is now drained
    const allRows = wakePendingRepo.listAll();
    expect(allRows[0]?.drainedAt).not.toBeNull();
    expect(allRows[0]?.drainedForTool).toBe("tasks.get");
  });

  test("second enrichWakeResponse call returns null (idempotent delivery)", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();
    const parentSessionId = "session-idem-789";

    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 7,
      event: "review-posted",
      keep: false,
      watcherId: TEST_WATCHER_ID,
      parentSessionId,
    });

    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);
    await runWatcher(prWatchRepo, fakeClientWithReview(3001), silentNotify, wakeSink);

    const first = await enrichWakeResponse(
      "tasks.get",
      { session: parentSessionId },
      wakePendingRepo,
      passthroughResolver
    );
    expect(first).not.toBeNull();

    const second = await enrichWakeResponse(
      "tasks.get",
      { session: parentSessionId },
      wakePendingRepo,
      passthroughResolver
    );
    expect(second).toBeNull(); // already drained — no re-delivery
  });

  test("watch without parentSessionId does not write to wake_pending", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();

    // Register without parentSessionId (legacy row or context-less registration)
    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 5,
      event: "review-posted",
      keep: false,
      watcherId: TEST_WATCHER_ID,
      // parentSessionId intentionally absent
    });

    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);
    const result = await runWatcher(
      prWatchRepo,
      fakeClientWithReview(4001),
      silentNotify,
      wakeSink
    );

    expect(result.fired).toBe(1);
    // No row in wake_pending — no session to route to
    expect(wakePendingRepo.listAll()).toHaveLength(0);
  });

  test("cross-session isolation: only the matching session receives the wake block", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();

    const sessionA = "session-cross-A";
    const sessionB = "session-cross-B";

    // Register two watches on the same PR — one for each session
    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 11,
      event: "review-posted",
      keep: false,
      watcherId: "operator:local:agent-A",
      parentSessionId: sessionA,
    });
    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 22,
      event: "review-posted",
      keep: false,
      watcherId: "operator:local:agent-B",
      parentSessionId: sessionB,
    });

    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);
    await runWatcher(prWatchRepo, fakeClientWithReview(5001), silentNotify, wakeSink);

    // Both watches fired; two rows in wake_pending
    const allRows = wakePendingRepo.listAll();
    expect(allRows).toHaveLength(2);

    // Drain for session A only
    const blockA = await enrichWakeResponse(
      "tasks.get",
      { session: sessionA },
      wakePendingRepo,
      passthroughResolver
    );
    expect(blockA).not.toBeNull();
    expect(blockA?.text).toContain(sessionA);
    expect(blockA?.text).not.toContain(sessionB);
    expect(blockA?.text).toContain('"prNumber":11');

    // Session B row stays undelivered
    const rowB = allRows.find((r) => r.parentSessionId === sessionB);
    expect(rowB?.drainedAt).toBeNull();
  });

  test("pr.watch.list tool in allowlist triggers enrichWakeResponse delivery", async () => {
    const prWatchRepo = new FakePrWatchRepository();
    const wakePendingRepo = new FakeWakePendingRepository();
    const parentSessionId = "session-list-tool";

    await prWatchRepo.create({
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 33,
      event: "merged",
      keep: false,
      watcherId: TEST_WATCHER_ID,
      parentSessionId,
    });

    // For merged event, we need getPr to return merged=true
    const mergedClient: GithubPrClient = {
      getPr: async () => ({ merged: true, title: "Merged PR" }),
      listReviews: async () => [],
      listCheckRuns: async () => [],
    };

    const wakeSink = new CompositeWakeSignalSink([
      new LoggingWakeSignalSink(silentLogger),
      new PersistentWakeSignalSink(wakePendingRepo),
    ]);
    await runWatcher(prWatchRepo, mergedClient, silentNotify, wakeSink);

    // pr.watch.list is in the allowlist — should deliver the wake block
    const block = await enrichWakeResponse(
      "pr.watch.list",
      { session: parentSessionId },
      wakePendingRepo,
      passthroughResolver
    );

    expect(block).not.toBeNull();
    expect(block?.text).toContain(`<wake-events tool="pr.watch.list"`);
    expect(block?.text).toContain('"kind":"pr.watch"');
    expect(block?.text).toContain('"reviewState":"merged"');
  });
});
