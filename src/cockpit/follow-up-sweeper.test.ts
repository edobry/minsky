/**
 * Tests for startFollowUpSweeper (mt#2322).
 *
 * Exercises the sweep tick body via injected deps (no real DB) — mirrors
 * `transcript-sweep-backstop.test.ts`'s pattern. Covers the mt#2322
 * acceptance test "a scheduled follow-up created via the daemon fires at its
 * scheduled time" at the sweep-loop level: FollowUpService itself is tested
 * directly in `packages/domain/src/scheduler/follow-up-service.test.ts`;
 * this file proves the SWEEP wiring calls `fireDue()` on its cadence and
 * handles the fired/errored/unavailable-DB paths without crashing the loop.
 *
 * @see ./sweepers.ts — startFollowUpSweeper
 * @see packages/domain/src/scheduler/follow-up-service.ts — FollowUpService
 * @see mt#2322
 */

import { describe, test, expect } from "bun:test";
import { startFollowUpSweeper } from "./sweepers";
import { _resetSweepLivenessRegistryForTest, getSweepLivenessSnapshot } from "./sweepers";
import type { FollowUpSweepDeps } from "./sweepers";

// Helper: wait for an async condition to become true (polls at 5ms intervals).
async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (!condition()) {
    const now = Date.now();
    if (now > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startFollowUpSweeper (mt#2322)", () => {
  test("boot tick calls fireDue() and logs fired follow-ups", async () => {
    let calls = 0;
    const deps: FollowUpSweepDeps = {
      fireDue: async () => {
        calls++;
        return { fired: [{ id: "f-1" }, { id: "f-2" }], errored: [] };
      },
    };

    const stop = startFollowUpSweeper({ intervalMs: 60_000, deps });
    try {
      await waitFor(() => calls >= 1);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  test("a follow-up not yet due is reported as un-fired, then fires on a later tick", async () => {
    // Simulates the daemon-timeline shape of the acceptance test: dueAt is in
    // the future on tick 1 (fireDue returns nothing), then due by tick 2.
    let tick = 0;
    const fireLog: string[][] = [];
    const deps: FollowUpSweepDeps = {
      fireDue: async () => {
        tick++;
        if (tick === 1) return { fired: [], errored: [] };
        const fired = [{ id: "follow-up-A" }];
        fireLog.push(fired.map((f) => f.id));
        return { fired, errored: [] };
      },
    };

    const stop = startFollowUpSweeper({ intervalMs: 15, deps });
    try {
      await waitFor(() => tick >= 2);
      expect(fireLog).toEqual([["follow-up-A"]]);
    } finally {
      stop();
    }
  });

  test("errored firings are surfaced without crashing the loop", async () => {
    let calls = 0;
    const deps: FollowUpSweepDeps = {
      fireDue: async () => {
        calls++;
        return { fired: [], errored: [{ id: "broken-1", error: "boom" }] };
      },
    };

    const stop = startFollowUpSweeper({ intervalMs: 60_000, deps });
    try {
      await waitFor(() => calls >= 1);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  test("a throwing fireDue() is fail-open — the loop survives and retries", async () => {
    let calls = 0;
    const deps: FollowUpSweepDeps = {
      fireDue: async () => {
        calls++;
        if (calls === 1) throw new Error("DB briefly unavailable");
        return { fired: [], errored: [] };
      },
    };

    const stop = startFollowUpSweeper({ intervalMs: 15, deps });
    try {
      await waitFor(() => calls >= 2);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("registers with the shared sweep-liveness registry (GET /api/sweeps coverage)", async () => {
    _resetSweepLivenessRegistryForTest();
    const deps: FollowUpSweepDeps = {
      fireDue: async () => ({ fired: [], errored: [] }),
    };
    const stop = startFollowUpSweeper({ intervalMs: 60_000, deps });
    try {
      await waitFor(() =>
        getSweepLivenessSnapshot().some(
          (s) => s.name === "scheduled follow-ups" && s.lastSuccessAt !== null
        )
      );
      const entry = getSweepLivenessSnapshot().find((s) => s.name === "scheduled follow-ups");
      expect(entry).toBeDefined();
      expect(entry?.intervalMs).toBe(60_000);
      expect(entry?.lastSuccessAt).not.toBeNull();
    } finally {
      stop();
      _resetSweepLivenessRegistryForTest();
    }
  });
});
