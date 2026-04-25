/**
 * Hermetic tests for PrWatchRepository using the FakePrWatchRepository.
 *
 * All tests run in-memory with no database dependency. The fake implements
 * the same interface as DrizzlePrWatchRepository, so correctness of the
 * interface contract is verified without requiring a live Postgres instance.
 *
 * Coverage:
 *   - create round-trip
 *   - getById (found + not found)
 *   - listActive filtering (untriggered, keep=true persistent, consumed one-shot)
 *   - markTriggered
 *   - delete
 *   - error paths (not found for markTriggered and delete)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakePrWatchRepository } from "./repository";
import type { CreatePrWatchInput } from "./repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<CreatePrWatchInput> = {}): CreatePrWatchInput {
  return {
    prOwner: "acme-org",
    prRepo: "my-repo",
    prNumber: 42,
    event: "merged",
    keep: false,
    watcherId: "operator:session:abc123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FakePrWatchRepository", () => {
  let repo: FakePrWatchRepository;

  beforeEach(() => {
    repo = new FakePrWatchRepository();
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("returns a watch with an assigned id and createdAt", async () => {
      const watch = await repo.create(makeInput());

      expect(watch.id).toBeDefined();
      expect(watch.id).toMatch(/^fake-pr-watch-/);
      expect(watch.createdAt).toBeDefined();
      expect(watch.triggeredAt).toBeUndefined();
    });

    it("persists all input fields correctly", async () => {
      const input = makeInput({
        prOwner: "owner-x",
        prRepo: "repo-y",
        prNumber: 99,
        event: "review-posted",
        keep: true,
        watcherId: "operator:task:mt#123",
        lastSeen: { lastReviewId: "r-111" },
        metadata: { source: "test" },
      });

      const watch = await repo.create(input);

      expect(watch.prOwner).toBe("owner-x");
      expect(watch.prRepo).toBe("repo-y");
      expect(watch.prNumber).toBe(99);
      expect(watch.event).toBe("review-posted");
      expect(watch.keep).toBe(true);
      expect(watch.watcherId).toBe("operator:task:mt#123");
      expect(watch.lastSeen).toEqual({ lastReviewId: "r-111" });
      expect(watch.metadata).toEqual({ source: "test" });
    });

    it("assigns incrementing ids for multiple creates", async () => {
      const w1 = await repo.create(makeInput());
      const w2 = await repo.create(makeInput());
      const w3 = await repo.create(makeInput());

      expect(w1.id).toBe("fake-pr-watch-1");
      expect(w2.id).toBe("fake-pr-watch-2");
      expect(w3.id).toBe("fake-pr-watch-3");
    });

    it("returns copies — mutations to returned object do not affect the store", async () => {
      const watch = await repo.create(makeInput());
      const mutableWatch = watch as { metadata: Record<string, unknown> };
      mutableWatch.metadata["injected"] = true;

      const fetched = await repo.getById(watch.id);
      expect(fetched?.metadata["injected"]).toBeUndefined();
    });

    it("defaults metadata to empty object when not provided", async () => {
      const watch = await repo.create(makeInput({ metadata: undefined }));
      expect(watch.metadata).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  describe("getById", () => {
    it("returns the watch when found", async () => {
      const created = await repo.create(makeInput());
      const fetched = await repo.getById(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
    });

    it("returns null when not found", async () => {
      const result = await repo.getById("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listActive
  // -------------------------------------------------------------------------

  describe("listActive", () => {
    it("returns all watches when none have been triggered", async () => {
      await repo.create(makeInput({ event: "merged" }));
      await repo.create(makeInput({ event: "review-posted" }));

      const active = await repo.listActive();
      expect(active).toHaveLength(2);
    });

    it("excludes one-shot watches that have been triggered", async () => {
      const w1 = await repo.create(makeInput({ keep: false }));
      await repo.create(makeInput({ keep: false }));

      await repo.markTriggered(w1.id);

      const active = await repo.listActive();
      // w1 has triggeredAt set and keep=false — should be excluded
      expect(active).toHaveLength(1);
      expect(active[0]?.id).not.toBe(w1.id);
    });

    it("includes persistent watches (keep=true) even after being triggered", async () => {
      const persistent = await repo.create(makeInput({ keep: true }));
      await repo.create(makeInput({ keep: false }));

      await repo.markTriggered(persistent.id);

      const active = await repo.listActive();
      // persistent has triggered_at but keep=true — should still be active
      const ids = active.map((w) => w.id);
      expect(ids).toContain(persistent.id);
    });

    it("returns empty list when all one-shot watches are consumed", async () => {
      const w1 = await repo.create(makeInput({ keep: false }));
      const w2 = await repo.create(makeInput({ keep: false }));

      await repo.markTriggered(w1.id);
      await repo.markTriggered(w2.id);

      const active = await repo.listActive();
      expect(active).toHaveLength(0);
    });

    it("returns empty list when store is empty", async () => {
      const active = await repo.listActive();
      expect(active).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // markTriggered
  // -------------------------------------------------------------------------

  describe("markTriggered", () => {
    it("sets triggeredAt to a non-null ISO string", async () => {
      const watch = await repo.create(makeInput());
      expect(watch.triggeredAt).toBeUndefined();

      const updated = await repo.markTriggered(watch.id);

      expect(updated.triggeredAt).toBeDefined();
      expect(typeof updated.triggeredAt).toBe("string");
      // verify it parses as a valid date
      expect(new Date(updated.triggeredAt as string).getTime()).toBeGreaterThan(0);
    });

    it("preserves all other fields", async () => {
      const input = makeInput({ event: "check-status-changed", keep: true });
      const watch = await repo.create(input);
      const updated = await repo.markTriggered(watch.id);

      expect(updated.id).toBe(watch.id);
      expect(updated.prOwner).toBe(watch.prOwner);
      expect(updated.event).toBe(watch.event);
      expect(updated.keep).toBe(watch.keep);
    });

    it("throws when watch not found", async () => {
      await expect(repo.markTriggered("nonexistent-id")).rejects.toThrow("PrWatch not found");
    });

    it("can be called multiple times on a keep=true watch", async () => {
      const watch = await repo.create(makeInput({ keep: true }));

      const first = await repo.markTriggered(watch.id);
      const second = await repo.markTriggered(watch.id);

      expect(first.triggeredAt).toBeDefined();
      expect(second.triggeredAt).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    it("removes the watch from the store", async () => {
      const watch = await repo.create(makeInput());
      expect(repo.all).toHaveLength(1);

      await repo.delete(watch.id);

      expect(repo.all).toHaveLength(0);
      const fetched = await repo.getById(watch.id);
      expect(fetched).toBeNull();
    });

    it("throws when watch not found", async () => {
      await expect(repo.delete("nonexistent-id")).rejects.toThrow("PrWatch not found");
    });

    it("only removes the targeted watch", async () => {
      const w1 = await repo.create(makeInput());
      const w2 = await repo.create(makeInput());

      await repo.delete(w1.id);

      expect(repo.all).toHaveLength(1);
      expect(repo.all[0]?.id).toBe(w2.id);
    });
  });

  // -------------------------------------------------------------------------
  // _seed test seam
  // -------------------------------------------------------------------------

  describe("_seed", () => {
    it("inserts a watch at an arbitrary state without going through create", async () => {
      const fixedWatch = {
        id: "seeded-id-001",
        prOwner: "seed-owner",
        prRepo: "seed-repo",
        prNumber: 1,
        event: "merged" as const,
        keep: false,
        watcherId: "operator:session:seed",
        createdAt: "2026-01-01T00:00:00.000Z",
        triggeredAt: "2026-01-02T00:00:00.000Z",
        metadata: {},
      };

      repo._seed(fixedWatch);

      const fetched = await repo.getById("seeded-id-001");
      expect(fetched?.id).toBe("seeded-id-001");
      expect(fetched?.triggeredAt).toBe("2026-01-02T00:00:00.000Z");
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe("clear", () => {
    it("empties the store and resets the id counter", async () => {
      await repo.create(makeInput());
      await repo.create(makeInput());
      repo.clear();

      expect(repo.all).toHaveLength(0);

      // id counter should restart at 1
      const fresh = await repo.create(makeInput());
      expect(fresh.id).toBe("fake-pr-watch-1");
    });
  });
});
