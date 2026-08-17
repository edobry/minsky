/**
 * Host wiring for embeddings degradation events (mt#4218).
 *
 * The defect these pin: `EmbeddingsHealthTracker`'s emitter is registered by the
 * process entry point, and until mt#4218 only `minsky mcp start` registered one.
 * In the cockpit daemon — which runs the per-turn embedding pipeline in-process —
 * `emitDegradationEvent` resolved `null` and returned `false` on every call,
 * before reaching a log line. Nothing errored; the event table simply had no row.
 *
 * Everything here is INJECTED, per ADR-036: a fake provider hands back a fake
 * drizzle handle whose `insert().values()` records the row. No module is patched,
 * and the assertions run through the real `buildEventEmitterFromProvider` and the
 * real `DrizzleEventEmitter`, so the seam under test is the production one.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { PersistenceProvider } from "../persistence/types";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";
import { registerEmbeddingsHealthEventEmitter } from "./embeddings-health-wiring";

interface RecordedRow {
  eventType: string;
  payload: unknown;
}

/** A drizzle handle whose `insert(...).values(...)` appends to `rows`. */
function fakeDb(rows: RecordedRow[]): unknown {
  return {
    insert: () => ({
      values: async (row: RecordedRow) => {
        rows.push(row);
      },
    }),
  };
}

/** A drizzle handle whose insert rejects — the ended-pool shape (mt#3721). */
function endedPoolDb(): unknown {
  return {
    insert: () => ({
      values: async () => {
        throw new Error("CONNECTION_ENDED");
      },
    }),
  };
}

function providerFor(db: unknown): PersistenceProvider {
  return { getDatabaseConnection: async () => db } as unknown as PersistenceProvider;
}

/** The condition `recordError` classifies as a degradation on the first call. */
async function degrade(tracker: EmbeddingsHealthTracker): Promise<void> {
  await tracker.recordError("openai", "insufficient_quota", "You exceeded your current quota");
}

describe("registerEmbeddingsHealthEventEmitter (mt#4218)", () => {
  beforeEach(() => {
    EmbeddingsHealthTracker.resetForTest();
  });

  test("NEGATIVE CONTROL: an unregistered host records nothing — the pre-fix cockpit", async () => {
    // This is the defect itself, pinned so the fix is observable. Note what it
    // does NOT do: throw, log an error, or leave the tracker in a bad state. The
    // in-memory health is correct and the event table is empty, which is why six
    // hours of degradation on 2026-08-17 left no trace.
    const rows: RecordedRow[] = [];
    const tracker = EmbeddingsHealthTracker.getInstance();

    await degrade(tracker);

    expect(rows).toHaveLength(0);
    expect(tracker.getSummary().status).toBe("exhausted");
  });

  test("a registered host emits exactly one event on a degradation", async () => {
    const rows: RecordedRow[] = [];
    registerEmbeddingsHealthEventEmitter(async () => providerFor(fakeDb(rows)));

    await degrade(EmbeddingsHealthTracker.getInstance());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("embeddings.provider_degraded");
  });

  test("a second error in the same cycle does not emit a duplicate", async () => {
    const rows: RecordedRow[] = [];
    registerEmbeddingsHealthEventEmitter(async () => providerFor(fakeDb(rows)));
    const tracker = EmbeddingsHealthTracker.getInstance();

    await degrade(tracker);
    await degrade(tracker);

    // The confirmed-emit latch (mt#2568 PR #2284 R2) is unchanged by this task;
    // this asserts adding a host did not change emission POLICY.
    expect(rows).toHaveLength(1);
  });

  test("the provider is resolved PER EMIT, so a recycled pool is picked up", async () => {
    // The mt#3721 hazard: the cockpit tears down and rebuilds its shared pool on
    // sustained degradation, and a handle cached across that boundary raises
    // CONNECTION_ENDED forever. Registering a BUILDER rather than an emitter is
    // what makes this work — assert it by having the first resolve hand back a
    // dead pool and the second a live one.
    const liveRows: RecordedRow[] = [];
    const resolved: string[] = [];
    let call = 0;

    registerEmbeddingsHealthEventEmitter(async () => {
      call += 1;
      if (call === 1) {
        resolved.push("ended");
        return providerFor(endedPoolDb());
      }
      resolved.push("live");
      return providerFor(fakeDb(liveRows));
    });

    const tracker = EmbeddingsHealthTracker.getInstance();
    await degrade(tracker);
    // First attempt hit the ended pool: tryEmit returned false, so the latch did
    // NOT set and this cycle is still retriable.
    expect(liveRows).toHaveLength(0);

    await degrade(tracker);

    expect(resolved).toEqual(["ended", "live"]);
    expect(liveRows).toHaveLength(1);
  });

  test("a resolver returning undefined is a no-op, not a crash", async () => {
    // The ordinary startup state: registered before persistence is up.
    registerEmbeddingsHealthEventEmitter(async () => undefined);
    const tracker = EmbeddingsHealthTracker.getInstance();

    await degrade(tracker);

    expect(tracker.getSummary().status).toBe("exhausted");
  });

  test("a resolver that THROWS is swallowed and leaves the cycle retriable", async () => {
    const rows: RecordedRow[] = [];
    let call = 0;
    registerEmbeddingsHealthEventEmitter(async () => {
      call += 1;
      if (call === 1) throw new Error("persistence init timed out");
      return providerFor(fakeDb(rows));
    });

    const tracker = EmbeddingsHealthTracker.getInstance();
    await degrade(tracker);
    expect(rows).toHaveLength(0);

    await degrade(tracker);
    expect(rows).toHaveLength(1);
  });
});
