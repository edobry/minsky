/**
 * Tests for the PR-watch reconciler (watcher.ts).
 *
 * Uses in-memory fakes for all external dependencies; no I/O.
 *
 * Coverage matrix:
 *   merged event
 *     - PR not merged → no-match
 *     - PR merged, one-shot → fired + deleted
 *     - PR merged, keep=true → fired + markTriggered
 *     - PR not found → no-match
 *   review-posted event
 *     - No reviews yet → no-match
 *     - Review ID ≤ lastSeen → no-match
 *     - New review ID > lastSeen → fired
 *     - lastSeen absent → fires on first review
 *   check-status-changed event
 *     - No change in conclusion → no-match
 *     - Conclusion changes from null to "success" → no-match (pending→success skip)
 *     - Conclusion changes from "success" to "failure" → fired
 *     - Still pending → no-match
 *   Error isolation
 *     - One watch throws → error outcome, others still processed
 *   One-shot vs persistent cleanup
 *     - One-shot: deleted after firing
 *     - Persistent (keep=true): markTriggered called, NOT deleted
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runWatcher } from "./watcher";
import type { GithubPrClient, GithubPr, GithubPrReview, GithubCheckRun } from "./watcher";
import { FakePrWatchRepository } from "./repository";
import type { PrWatch, PrWatchEvent } from "./types";
import type { OperatorNotify } from "../notify/operator-notify";

// ---------------------------------------------------------------------------
// Constants — extracted to silence custom/no-magic-string-duplication
// ---------------------------------------------------------------------------

const EVENT_CHECK_STATUS_CHANGED: PrWatchEvent = "check-status-changed";

// ---------------------------------------------------------------------------
// Fake GithubPrClient
// ---------------------------------------------------------------------------

interface FakePrData {
  merged: boolean;
  title: string;
}

class FakeGithubPrClient implements GithubPrClient {
  private prs = new Map<string, FakePrData>();
  private reviews = new Map<string, GithubPrReview[]>();
  private checkRuns = new Map<string, GithubCheckRun[]>();

  private key(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}#${prNumber}`;
  }

  setPr(owner: string, repo: string, prNumber: number, data: FakePrData): void {
    this.prs.set(this.key(owner, repo, prNumber), data);
  }

  setReviews(owner: string, repo: string, prNumber: number, reviews: GithubPrReview[]): void {
    this.reviews.set(this.key(owner, repo, prNumber), reviews);
  }

  setCheckRuns(owner: string, repo: string, prNumber: number, checkRuns: GithubCheckRun[]): void {
    this.checkRuns.set(this.key(owner, repo, prNumber), checkRuns);
  }

  async getPr(owner: string, repo: string, prNumber: number): Promise<GithubPr | null> {
    return this.prs.get(this.key(owner, repo, prNumber)) ?? null;
  }

  async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubPrReview[]> {
    return this.reviews.get(this.key(owner, repo, prNumber)) ?? [];
  }

  async listCheckRuns(owner: string, repo: string, prNumber: number): Promise<GithubCheckRun[]> {
    return this.checkRuns.get(this.key(owner, repo, prNumber)) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Fake OperatorNotify
// ---------------------------------------------------------------------------

class FakeOperatorNotify implements OperatorNotify {
  bells = 0;
  notifications: Array<{ title: string; body: string }> = [];
  shouldThrow = false;

  bell(): void {
    if (this.shouldThrow) throw new Error("bell failed");
    this.bells++;
  }

  notify(title: string, body: string): void {
    if (this.shouldThrow) throw new Error("notify failed");
    this.notifications.push({ title, body });
  }

  reset(): void {
    this.bells = 0;
    this.notifications = [];
    this.shouldThrow = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseWatch(overrides: Partial<PrWatch> = {}): PrWatch {
  return {
    id: "watch-1",
    prOwner: "acme",
    prRepo: "monorepo",
    prNumber: 42,
    event: "merged",
    keep: false,
    watcherId: "operator:local:default",
    createdAt: new Date().toISOString(),
    triggeredAt: undefined,
    metadata: {},
    ...overrides,
  };
}

/** Read the first notification with a guard. Asserts presence and returns it. */
function firstNotification(notify: FakeOperatorNotify): { title: string; body: string } {
  expect(notify.notifications.length).toBeGreaterThan(0);
  const n = notify.notifications[0];
  if (!n) throw new Error("unreachable: notifications guarded");
  return n;
}

/** Read first row from `repo.all` with a guard. */
function firstWatch(repo: FakePrWatchRepository): PrWatch {
  expect(repo.all.length).toBeGreaterThan(0);
  const w = repo.all[0];
  if (!w) throw new Error("unreachable: repo.all guarded");
  return w;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let repo: FakePrWatchRepository;
let client: FakeGithubPrClient;
let notify: FakeOperatorNotify;

beforeEach(() => {
  repo = new FakePrWatchRepository();
  client = new FakeGithubPrClient();
  notify = new FakeOperatorNotify();
});

// ---------------------------------------------------------------------------
// merged event
// ---------------------------------------------------------------------------

describe("merged event", () => {
  it("no-match when PR is not yet merged", async () => {
    repo._seed(makeBaseWatch({ event: "merged" }));
    client.setPr("acme", "monorepo", 42, { merged: false, title: "My PR" });

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(notify.bells).toBe(0);
    expect(repo.all).toHaveLength(1);
  });

  it("fires and deletes one-shot watch when PR is merged", async () => {
    repo._seed(makeBaseWatch({ event: "merged", keep: false }));
    client.setPr("acme", "monorepo", 42, { merged: true, title: "My PR" });

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    expect(notify.bells).toBe(1);
    expect(notify.notifications).toHaveLength(1);
    const note = firstNotification(notify);
    expect(note.title).toBe("Minsky: PR merged");
    expect(note.body).toContain("#42");
    expect(repo.all).toHaveLength(0);
  });

  it("fires and markTriggered for keep=true watch when PR is merged", async () => {
    repo._seed(makeBaseWatch({ event: "merged", keep: true }));
    client.setPr("acme", "monorepo", 42, { merged: true, title: "My PR" });

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    expect(notify.bells).toBe(1);
    expect(repo.all).toHaveLength(1);
    const w = firstWatch(repo);
    expect(w.triggeredAt).toBeDefined();
  });

  it("no-match when GitHub PR is not found", async () => {
    repo._seed(makeBaseWatch({ event: "merged" }));

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(notify.bells).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// review-posted event
// ---------------------------------------------------------------------------

describe("review-posted event", () => {
  it("no-match when no reviews exist", async () => {
    repo._seed(makeBaseWatch({ event: "review-posted" }));

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(notify.bells).toBe(0);
  });

  it("no-match when review ID is not greater than lastSeen", async () => {
    repo._seed(makeBaseWatch({ event: "review-posted", lastSeen: { lastReviewId: 100 } }));
    client.setReviews("acme", "monorepo", 42, [
      { id: 100, state: "APPROVED", reviewerLogin: "alice" },
      { id: 50, state: "COMMENTED", reviewerLogin: "bob" },
    ]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(notify.bells).toBe(0);
  });

  it("fires when a review ID is greater than lastSeen", async () => {
    repo._seed(
      makeBaseWatch({ event: "review-posted", keep: false, lastSeen: { lastReviewId: 50 } })
    );
    client.setReviews("acme", "monorepo", 42, [
      { id: 50, state: "COMMENTED", reviewerLogin: "bob" },
      { id: 101, state: "APPROVED", reviewerLogin: "alice" },
    ]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    expect(notify.bells).toBe(1);
    const note = firstNotification(notify);
    expect(note.title).toBe("Minsky: PR review posted");
    expect(note.body).toContain("#42");
    expect(note.body).toContain("APPROVED");
    expect(repo.all).toHaveLength(0);
  });

  it("fires when lastSeen is absent (first review ever)", async () => {
    repo._seed(makeBaseWatch({ event: "review-posted", keep: false }));
    client.setReviews("acme", "monorepo", 42, [
      { id: 1, state: "CHANGES_REQUESTED", reviewerLogin: "carol" },
    ]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    expect(notify.bells).toBe(1);
    const note = firstNotification(notify);
    expect(note.body).toContain("CHANGES_REQUESTED");
  });
});

// ---------------------------------------------------------------------------
// check-status-changed event
// ---------------------------------------------------------------------------

describe("check-status-changed event", () => {
  it("no-match when no check runs exist", async () => {
    repo._seed(makeBaseWatch({ event: EVENT_CHECK_STATUS_CHANGED }));

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("no-match when conclusion unchanged from lastSeen", async () => {
    repo._seed(
      makeBaseWatch({
        event: EVENT_CHECK_STATUS_CHANGED,
        lastSeen: { lastConclusion: "success" },
      })
    );
    client.setCheckRuns("acme", "monorepo", 42, [{ name: "ci", conclusion: "success" }]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("no-match when checks are still pending (conclusion = null)", async () => {
    repo._seed(makeBaseWatch({ event: EVENT_CHECK_STATUS_CHANGED }));
    client.setCheckRuns("acme", "monorepo", 42, [{ name: "ci", conclusion: null }]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it("fires when conclusion changes from success to failure", async () => {
    repo._seed(
      makeBaseWatch({
        event: EVENT_CHECK_STATUS_CHANGED,
        keep: false,
        lastSeen: { lastConclusion: "success" },
      })
    );
    client.setCheckRuns("acme", "monorepo", 42, [{ name: "ci", conclusion: "failure" }]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    expect(notify.bells).toBe(1);
    const note = firstNotification(notify);
    expect(note.title).toBe("Minsky: PR check status changed");
    expect(note.body).toContain("failure");
    expect(repo.all).toHaveLength(0);
  });

  it("fires when conclusion changes from null (never seen) to success", async () => {
    repo._seed(
      makeBaseWatch({
        event: EVENT_CHECK_STATUS_CHANGED,
        keep: false,
        lastSeen: { lastConclusion: null },
      })
    );
    client.setCheckRuns("acme", "monorepo", 42, [{ name: "ci", conclusion: "success" }]);

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    const note = firstNotification(notify);
    expect(note.body).toContain("success");
  });
});

// ---------------------------------------------------------------------------
// Error isolation — multi-watch
// ---------------------------------------------------------------------------

describe("error isolation", () => {
  it("continues processing remaining watches when one throws", async () => {
    const badWatch = makeBaseWatch({ id: "watch-bad", event: "merged" });
    const goodWatch = makeBaseWatch({
      id: "watch-good",
      event: "merged",
      prNumber: 99,
    });
    repo._seed(badWatch);
    repo._seed(goodWatch);

    const throwingClient: GithubPrClient = {
      async getPr(_owner, _repo, prNumber) {
        if (prNumber === 42) throw new Error("GitHub API timeout");
        return { merged: false, title: "Good PR" };
      },
      async listReviews() {
        return [];
      },
      async listCheckRuns() {
        return [];
      },
    };

    const result = await runWatcher(repo, throwingClient, notify);

    expect(result.errors).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.inspected).toBe(2);
    const errorOutcome = result.outcomes.find((o) => o.kind === "error");
    expect(errorOutcome).toBeDefined();
    if (errorOutcome && errorOutcome.kind === "error") {
      expect(errorOutcome.error).toContain("GitHub API timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// Notification failure resilience
// ---------------------------------------------------------------------------

describe("notification failure", () => {
  it("state mutation (delete) is not rolled back when notify throws", async () => {
    repo._seed(makeBaseWatch({ event: "merged", keep: false }));
    client.setPr("acme", "monorepo", 42, { merged: true, title: "My PR" });

    notify.shouldThrow = true;

    const result = await runWatcher(repo, client, notify);

    expect(result.fired).toBe(1);
    const outcome = result.outcomes[0];
    expect(outcome).toBeDefined();
    if (outcome && outcome.kind === "fired") {
      expect(outcome.notified).toBe(false);
    }
    expect(repo.all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty pass
// ---------------------------------------------------------------------------

describe("empty pass", () => {
  it("returns zero counts when no watches are active", async () => {
    const result = await runWatcher(repo, client, notify);

    expect(result.inspected).toBe(0);
    expect(result.fired).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.outcomes).toHaveLength(0);
  });
});
