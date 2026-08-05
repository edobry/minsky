/**
 * Regression tests for mt#2568: getAskStateCounts per-call repo fallback.
 *
 * Pre-fix bug: getAskStateCounts() had `if (!wiredRepo) return { available:
 * false, ... }` — so whenever the one-shot setAskStateCountsRepository()
 * startup wiring in start-command.ts hadn't fired yet (e.g. on proxy /
 * staleness-respawned servers, mirroring the mt#2562/mt#2567 presence
 * write-path race), the stuck-pipeline detector reported permanently
 * unavailable for the life of the process.
 *
 * Fix: build the repo per-call via a registered fallback builder when
 * wiredRepo is not pre-set — mirrors the buildAskRepository /
 * getPresenceClaimRepo per-call fallback pattern from mt#2567.
 * setAskStateCountsRepository() becomes a warm-up fast-path only.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  getAskStateCounts,
  setAskStateCountsRepository,
  registerAskStateCountsBuilder,
  resetAskStateCountsRepository,
} from "./state-counts-provider";
import { ALL_ASK_STATES } from "./state-machine";
import type { AskRepository } from "./repository";
import type { AskState } from "./types";

function zeroFilled(): Record<AskState, number> {
  return Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<AskState, number>;
}

function fakeCounts(overrides: Partial<Record<AskState, number>>): Record<AskState, number> {
  return { ...zeroFilled(), ...overrides };
}

describe("getAskStateCounts per-call repo fallback (mt#2568 regression)", () => {
  beforeEach(() => {
    resetAskStateCountsRepository();
  });

  afterEach(() => {
    resetAskStateCountsRepository();
  });

  test("REGRESSION: builds via per-call builder when setAskStateCountsRepository was never called", async () => {
    // This test reproduces the mt#2568 bug:
    // - Pre-fix code: `if (!wiredRepo) return { available: false, ... }` — the
    //   fallback builder is never consulted.
    // - Post-fix code: per-call fallback invokes the registered builder →
    //   real counts returned even though the one-shot setter never fired.

    // `closed`, not `resolved`: there is no `resolved` AskState (ask/types.ts).
    // The old key just rode along on the object spread, so the assertion below
    // read back a state the system never produces.
    const countByStateMock = mock(async () => fakeCounts({ detected: 3, closed: 2 }));
    const fakeRepo = { countByState: countByStateMock } as unknown as AskRepository;

    let builderCallCount = 0;
    registerAskStateCountsBuilder(async () => {
      builderCallCount++;
      return fakeRepo;
    });

    // CRITICAL: do NOT call setAskStateCountsRepository(...) — this
    // simulates the one-shot startup wiring in start-command.ts never
    // completing before the first debug.systemInfo call, the exact
    // mt#2568 failure scenario.

    const snapshot = await getAskStateCounts();

    expect(builderCallCount).toBeGreaterThanOrEqual(1);
    expect(countByStateMock.mock.calls.length).toBe(1);
    expect(snapshot.available).toBe(true);
    expect(snapshot.total).toBe(5);
    expect(snapshot.byState.detected).toBe(3);
    expect(snapshot.byState.closed).toBe(2);
  });

  test("fast-path: uses pre-set repo without going through the builder", async () => {
    const countByStateMock = mock(async () => fakeCounts({ detected: 1 }));
    const fakeRepo = { countByState: countByStateMock } as unknown as AskRepository;

    let builderCallCount = 0;
    registerAskStateCountsBuilder(async () => {
      builderCallCount++;
      return fakeRepo;
    });

    setAskStateCountsRepository(fakeRepo);

    const snapshot = await getAskStateCounts();

    expect(snapshot.available).toBe(true);
    expect(snapshot.byState.detected).toBe(1);
    // The fast-path repo was used directly — the fallback builder was never invoked.
    expect(builderCallCount).toBe(0);
  });

  test("returns available:false when neither the fast-path repo nor a builder is registered", async () => {
    const snapshot = await getAskStateCounts();

    expect(snapshot.available).toBe(false);
    expect(snapshot.total).toBe(0);
    expect(snapshot.byState).toEqual(zeroFilled());
  });

  test("returns available:false gracefully when the builder throws", async () => {
    registerAskStateCountsBuilder(async () => {
      throw new Error("container has no persistence provider");
    });

    await expect(getAskStateCounts()).resolves.toEqual({
      available: false,
      total: 0,
      byState: zeroFilled(),
    });
  });

  test("returns available:false gracefully when the builder resolves to null", async () => {
    registerAskStateCountsBuilder(async () => null);

    const snapshot = await getAskStateCounts();

    expect(snapshot.available).toBe(false);
    expect(snapshot.byState).toEqual(zeroFilled());
  });
});
