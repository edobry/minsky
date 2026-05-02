/**
 * Tests for ServiceWindowReaper — mt#1490.
 *
 * All tests use FakeAskRepository and a recording dispatch callback —
 * hermetic, no DB or Postgres connection required.
 *
 * Covers:
 *   - onWindowOpened: dispatches eligible suspended Asks
 *   - onWindowOpened: idempotent (already-routed Asks skipped)
 *   - onWindowClosed: increments missed count for still-suspended Asks
 *   - onWindowClosed: escalates when maxMisses reached
 *   - onWindowClosed: does not escalate when maxMisses=-1 (infinite)
 *   - onWindowClosed: emits correct summary payload
 *   - pollDeadlineBoundAsks: dispatches urgent deadline-bound Asks
 *   - pollDeadlineBoundAsks: skips non-urgent Asks
 *   - startupSweep: idempotent recovery after restart
 *   - forceImmediate anti-pattern recording
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ServiceWindowReaper } from "./service-window-reaper";
import { FakeAskRepository } from "./repository";
import type { Ask } from "./types";
import type { WindowOpenedPayload, WindowClosedPayload } from "./attention-windows/notify";
import type { AttentionWindowConfig } from "./attention-windows/config";
import { InMemoryForceImmediateCounterStore } from "./force-immediate-counters";
import { PAGE_THRESHOLD_MS } from "./router";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_NOW_MS = new Date("2025-01-15T12:00:00.000Z").getTime();
const WINDOW_KEY = "ask-hours";
const REQUESTOR = "test-agent:proc:abc123";
const KIND_DIR_DECIDE = "direction.decide" as const;
const KIND_STUCK_UNBLOCK = "stuck.unblock" as const;

function makeSuspendedAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: `ask-${Math.random().toString(36).slice(2, 8)}`,
    kind: KIND_DIR_DECIDE,
    classifierVersion: "v1",
    requestor: REQUESTOR,
    state: "suspended",
    title: "Test ask",
    question: "What direction?",
    createdAt: new Date(BASE_NOW_MS - 60_000).toISOString(),
    serviceStrategy: "scheduled",
    windowKey: WINDOW_KEY,
    windowMissedCount: 0,
    forceImmediate: false,
    metadata: {},
    ...overrides,
  };
}

function makeWindowOpenedPayload(windowKey = WINDOW_KEY): WindowOpenedPayload {
  return {
    windowKey,
    openedAt: new Date(BASE_NOW_MS).toISOString(),
    durationMin: 30,
    expectedCloseAt: new Date(BASE_NOW_MS + 30 * 60 * 1000).toISOString(),
  };
}

function makeWindowClosedPayload(windowKey = WINDOW_KEY): WindowClosedPayload {
  return {
    windowKey,
    closedAt: new Date(BASE_NOW_MS + 30 * 60 * 1000).toISOString(),
  };
}

const DEFAULT_WINDOW_CONFIGS: AttentionWindowConfig[] = [
  {
    key: WINDOW_KEY,
    schedule: { type: "cron", expr: "0 16 * * 1-5" },
    durationMin: 30,
    maxMisses: 2,
    description: "Daily 4pm decision window",
  },
];

// ---------------------------------------------------------------------------
// Helper: recording dispatch callback
// ---------------------------------------------------------------------------

interface DispatchRecord {
  ask: Ask;
  reason: string;
}

function makeRecordingDispatch(): {
  dispatched: DispatchRecord[];
  callback: (ask: Ask, reason: string) => Promise<void>;
} {
  const dispatched: DispatchRecord[] = [];
  const callback = async (ask: Ask, reason: string): Promise<void> => {
    dispatched.push({ ask, reason });
  };
  return { dispatched, callback };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let repo: FakeAskRepository;
let counterStore: InMemoryForceImmediateCounterStore;

beforeEach(() => {
  repo = new FakeAskRepository();
  counterStore = new InMemoryForceImmediateCounterStore();
});

// ---------------------------------------------------------------------------
// onWindowOpened
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper.onWindowOpened", () => {
  it("dispatches all eligible suspended Asks when window opens", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.onWindowOpened(makeWindowOpenedPayload());

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.ask.id).toBe(ask.id);
  });

  it("transitions Ask from suspended to routed on dispatch", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.onWindowOpened(makeWindowOpenedPayload());

    // After dispatch, the Ask should be in "routed" state.
    const updated = await repo.getById(ask.id);
    expect(updated?.state).toBe("routed");
  });

  it("does not dispatch Asks for a different window", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: "weekly-review",
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.onWindowOpened(makeWindowOpenedPayload(WINDOW_KEY));

    expect(dispatched.length).toBe(0);
  });

  it("is idempotent: skips already-routed Asks", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    // First open: dispatches the Ask.
    await reaper.onWindowOpened(makeWindowOpenedPayload());
    expect(dispatched.length).toBe(1);

    // Second open (restart simulation): Ask is already routed — should skip.
    await reaper.onWindowOpened(makeWindowOpenedPayload());
    expect(dispatched.length).toBe(1); // No new dispatch
  });

  it("handles multiple Asks in priority order (stuck.unblock before direction.decide)", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ts = new Date(BASE_NOW_MS - 60_000).toISOString();
    const directionAsk = makeSuspendedAsk({
      id: "ask-direction",
      kind: KIND_DIR_DECIDE,
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      createdAt: ts,
      state: "suspended",
    });
    const stuckAsk = makeSuspendedAsk({
      id: "ask-stuck",
      kind: KIND_STUCK_UNBLOCK,
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      createdAt: ts,
      state: "suspended",
    });

    repo._seedAtState(directionAsk);
    repo._seedAtState(stuckAsk);

    await reaper.onWindowOpened(makeWindowOpenedPayload());

    expect(dispatched.length).toBe(2);
    // stuck.unblock should be dispatched first (higher priority)
    expect(dispatched[0]?.ask.kind).toBe(KIND_STUCK_UNBLOCK);
    expect(dispatched[1]?.ask.kind).toBe(KIND_DIR_DECIDE);
  });

  it("dispatch reason includes the window key", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({ state: "suspended" });
    repo._seedAtState(ask);

    await reaper.onWindowOpened(makeWindowOpenedPayload());

    expect(dispatched[0]?.reason).toContain(WINDOW_KEY);
  });
});

// ---------------------------------------------------------------------------
// onWindowClosed
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper.onWindowClosed", () => {
  it("returns correct summary when no Asks are still suspended (all served)", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    // Simulate an Ask that was dispatched during the window (now routed).
    const ask = makeSuspendedAsk({
      state: "routed", // Already dispatched during window-open
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
    });
    repo._seedAtState(ask);

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.escalatedCount).toBe(0);
    expect(summary.reBatchedCount).toBe(0);
    expect(summary.droppedCount).toBe(0);
    // servedCount counts routed asks in the cohort that are no longer suspended
    expect(summary.servedCount).toBeGreaterThanOrEqual(0);
  });

  it("increments miss count (re-batches) when Ask is still suspended and maxMisses not reached", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    // maxMisses=2, first miss (count goes 0→1, below threshold)
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 0,
    });
    repo._seedAtState(ask);

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.reBatchedCount).toBe(1);
    expect(summary.escalatedCount).toBe(0);
  });

  it("escalates Ask when windowMissedCount reaches maxMisses threshold", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    // maxMisses=2, Ask already missed once (count=1), this close brings it to 2
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 1, // After this close, newMissCount=2 == maxMisses=2
    });
    repo._seedAtState(ask);

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.escalatedCount).toBe(1);
    expect(summary.reBatchedCount).toBe(0);
    // Should have dispatched the escalated Ask
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.reason).toContain("escalation");
  });

  it("escalated Ask has forceImmediate=true", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 1, // Will reach maxMisses=2
    });
    repo._seedAtState(ask);

    await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(dispatched[0]?.ask.forceImmediate).toBe(true);
  });

  it("never escalates when maxMisses=-1 (infinite patience)", async () => {
    const { dispatched, callback } = makeRecordingDispatch();

    const infiniteWindowConfigs: AttentionWindowConfig[] = [
      {
        key: WINDOW_KEY,
        schedule: { type: "cron", expr: "0 16 * * 1-5" },
        durationMin: 30,
        maxMisses: -1, // Never escalate
      },
    ];

    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: infiniteWindowConfigs },
      counterStore
    );

    // Even after many misses, should not escalate
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 100, // Very high miss count
    });
    repo._seedAtState(ask);

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.escalatedCount).toBe(0);
    expect(summary.reBatchedCount).toBe(1);
    expect(dispatched.length).toBe(0);
  });

  it("uses maxMisses=-1 as default when no window config is present (no escalation)", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    // No window configs — should default to no-escalation
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 99,
    });
    repo._seedAtState(ask);

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.escalatedCount).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("emits summary with droppedCount=0 (v1 has no drop logic)", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    const summary = await reaper.onWindowClosed(makeWindowClosedPayload());

    expect(summary.droppedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pollDeadlineBoundAsks
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper.pollDeadlineBoundAsks", () => {
  it("dispatches deadline-bound Ask within page-threshold", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const deadline = new Date(BASE_NOW_MS + 10 * 60 * 1000).toISOString(); // 10min — within threshold
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline,
      state: "suspended",
    });
    repo._seedAtState(ask);

    const count = await reaper.pollDeadlineBoundAsks(BASE_NOW_MS);

    expect(count).toBe(1);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.reason).toContain("deadline-bound poll");
  });

  it("does not dispatch deadline-bound Ask beyond threshold", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const deadline = new Date(BASE_NOW_MS + 2 * 60 * 60 * 1000).toISOString(); // 2h — beyond threshold
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline,
      state: "suspended",
    });
    repo._seedAtState(ask);

    const count = await reaper.pollDeadlineBoundAsks(BASE_NOW_MS);

    expect(count).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("does not dispatch non-deadline-bound Asks", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    const count = await reaper.pollDeadlineBoundAsks(BASE_NOW_MS);

    expect(count).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("transitions Ask to routed on poll dispatch", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const deadline = new Date(BASE_NOW_MS + 5 * 60 * 1000).toISOString(); // 5min
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline,
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.pollDeadlineBoundAsks(BASE_NOW_MS);

    const updated = await repo.getById(ask.id);
    expect(updated?.state).toBe("routed");
  });

  it("dispatches exactly at the page-threshold boundary", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const deadline = new Date(BASE_NOW_MS + PAGE_THRESHOLD_MS).toISOString(); // exactly at threshold
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline,
      state: "suspended",
    });
    repo._seedAtState(ask);

    const count = await reaper.pollDeadlineBoundAsks(BASE_NOW_MS);

    expect(count).toBe(1);
    expect(dispatched.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startupSweep (idempotent recovery)
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper.startupSweep", () => {
  it("dispatches deadline-bound Asks within threshold on startup", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    // Deadline 5 minutes after BASE_NOW_MS — within page threshold.
    // Pass BASE_NOW_MS to startupSweep so the test is hermetic (no real Date.now()).
    const deadline = new Date(BASE_NOW_MS + 5 * 60 * 1000).toISOString();
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline,
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.startupSweep(BASE_NOW_MS);

    // Should have dispatched the urgent Ask
    expect(dispatched.length).toBe(1);
  });

  it("does not dispatch scheduled Asks on startup (only deadline-bound)", async () => {
    const { dispatched, callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(repo, callback, {}, counterStore);

    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    await reaper.startupSweep();

    expect(dispatched.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// forceImmediate anti-pattern recording
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper: forceImmediate recording", () => {
  it("records in counter store when escalating an Ask", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    // windowMissedCount=1, maxMisses=2 → will escalate on this close
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      windowMissedCount: 1,
      requestor: REQUESTOR,
    });
    repo._seedAtState(ask);

    await reaper.onWindowClosed(makeWindowClosedPayload());

    // The escalation records a forceImmediate usage
    const record = counterStore.getRecord(REQUESTOR);
    expect(record).not.toBeNull();
    expect(record?.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// windowMissedCount persistence — R1 fix verification
// ---------------------------------------------------------------------------

describe("ServiceWindowReaper: windowMissedCount persistence (R1 fix)", () => {
  it("persists windowMissedCount on the Ask row after onWindowClosed", async () => {
    const { callback } = makeRecordingDispatch();
    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: DEFAULT_WINDOW_CONFIGS },
      counterStore
    );

    // Start with windowMissedCount=0 (as produced by createAsk).
    // Do NOT seed windowMissedCount directly — we must observe the persistence flow.
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      // windowMissedCount intentionally not overridden — uses makeSuspendedAsk default of 0
    });
    repo._seedAtState(ask);

    // First window close: count goes 0 → 1.
    await reaper.onWindowClosed(makeWindowClosedPayload());

    // Re-read the Ask from the repo to verify the count was persisted.
    const afterFirst = await repo.getById(ask.id);
    expect(afterFirst?.windowMissedCount).toBe(1);
  });

  it("persists windowMissedCount across consecutive onWindowClosed calls", async () => {
    const { callback } = makeRecordingDispatch();

    // Use maxMisses=5 so we get multiple increments without escalation.
    const multiMissConfigs: AttentionWindowConfig[] = [
      {
        key: WINDOW_KEY,
        schedule: { type: "cron", expr: "0 16 * * 1-5" },
        durationMin: 30,
        maxMisses: 5,
        description: "Daily 4pm decision window (many-miss variant)",
      },
    ];

    const reaper = new ServiceWindowReaper(
      repo,
      callback,
      { windowConfigs: multiMissConfigs },
      counterStore
    );

    // Seed a fresh suspended Ask at windowMissedCount=0.
    const ask = makeSuspendedAsk({
      state: "suspended",
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
    });
    repo._seedAtState(ask);

    // First close: 0 → 1.
    await reaper.onWindowClosed(makeWindowClosedPayload());
    const afterFirst = await repo.getById(ask.id);
    expect(afterFirst?.windowMissedCount).toBe(1);

    // Second close: 1 → 2.  The reaper must read the persisted count, not
    // an in-memory snapshot, so this verifies round-trip persistence.
    await reaper.onWindowClosed(makeWindowClosedPayload());
    const afterSecond = await repo.getById(ask.id);
    expect(afterSecond?.windowMissedCount).toBe(2);

    // Third close: 2 → 3.
    await reaper.onWindowClosed(makeWindowClosedPayload());
    const afterThird = await repo.getById(ask.id);
    expect(afterThird?.windowMissedCount).toBe(3);
  });
});
