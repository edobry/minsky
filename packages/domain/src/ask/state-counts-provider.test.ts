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
  DEFAULT_ASK_STALL_THRESHOLD_MS,
} from "./state-counts-provider";
import { ALL_ASK_STATES } from "./state-machine";
import { emptyOpenStateAgeStats } from "./repository";
import type { AskRepository, AskAgeStats } from "./repository";
import type { OpenAskState } from "./state-machine";
import type { AskState } from "./types";

function zeroFilled(): Record<AskState, number> {
  return Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<AskState, number>;
}

function fakeCounts(overrides: Partial<Record<AskState, number>>): Record<AskState, number> {
  return { ...zeroFilled(), ...overrides };
}

/**
 * The snapshot every unavailable path must return (mt#4361).
 *
 * Written once so the two "available: false" assertions below cannot drift
 * apart — and so adding a field to `AskStateCountsSnapshot` fails HERE, in one
 * place, rather than in whichever assertion happened to spell the shape out.
 */
function unavailableSnapshot() {
  return {
    available: false,
    total: 0,
    byState: zeroFilled(),
    stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS,
    ageByState: emptyOpenStateAgeStats(),
  };
}

/**
 * A repository double covering both reads `getAskStateCounts` makes.
 *
 * `openStateAgeStats` is NOT optional here: the provider calls both in a
 * `Promise.all`, so a double missing it throws a TypeError that the provider's
 * own catch converts into `available: false` — a green-looking failure that
 * would report the wiring as broken rather than the double as incomplete.
 */
function repoDouble(
  countByState: () => Promise<Record<AskState, number>>,
  ageByState: Record<OpenAskState, AskAgeStats> = emptyOpenStateAgeStats()
): AskRepository {
  return {
    countByState,
    openStateAgeStats: async () => ageByState,
  } as unknown as AskRepository;
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
    const fakeRepo = repoDouble(countByStateMock);

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
    const fakeRepo = repoDouble(countByStateMock);

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

  test("AT3: returns available:false when neither the fast-path repo nor a builder is registered", async () => {
    await expect(getAskStateCounts()).resolves.toEqual(unavailableSnapshot());
  });

  test("AT3: returns available:false gracefully when the builder throws", async () => {
    registerAskStateCountsBuilder(async () => {
      throw new Error("container has no persistence provider");
    });

    await expect(getAskStateCounts()).resolves.toEqual(unavailableSnapshot());
  });

  test("AT3: returns available:false gracefully when the builder resolves to null", async () => {
    registerAskStateCountsBuilder(async () => null);

    await expect(getAskStateCounts()).resolves.toEqual(unavailableSnapshot());
  });
});

describe("getAskStateCounts age dimension (mt#4361)", () => {
  beforeEach(() => {
    resetAskStateCountsRepository();
  });

  afterEach(() => {
    resetAskStateCountsRepository();
  });

  test("carries per-state ages and the threshold they were computed against", async () => {
    const ages = emptyOpenStateAgeStats();
    ages.routed = { oldestAgeMs: 9 * 24 * 60 * 60 * 1000, stalledCount: 1 };

    setAskStateCountsRepository(
      repoDouble(async () => fakeCounts({ routed: 3, suspended: 2 }), ages)
    );

    const snapshot = await getAskStateCounts();

    expect(snapshot.available).toBe(true);
    expect(snapshot.byState.routed).toBe(3);
    expect(snapshot.ageByState.routed).toEqual({
      oldestAgeMs: 9 * 24 * 60 * 60 * 1000,
      stalledCount: 1,
    });
    // Without this the "1 stalled" above is not a finding — the reader has no
    // way to know "older than what", and the threshold is a tunable.
    expect(snapshot.stallThresholdMs).toBe(DEFAULT_ASK_STALL_THRESHOLD_MS);
  });

  test("the stall threshold is the 5-day figure decision-defaults grounds it in", () => {
    expect(DEFAULT_ASK_STALL_THRESHOLD_MS).toBe(5 * 24 * 60 * 60 * 1000);
  });

  test("an empty open state reports null age, not a zero that reads as fresh", async () => {
    setAskStateCountsRepository(repoDouble(async () => fakeCounts({ closed: 12 })));

    const snapshot = await getAskStateCounts();

    expect(snapshot.available).toBe(true);
    expect(snapshot.ageByState.routed.oldestAgeMs).toBeNull();
    expect(snapshot.ageByState.routed.stalledCount).toBe(0);
  });
});
