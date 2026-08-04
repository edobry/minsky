/**
 * Tests for the schema-readiness gate (mt#3297).
 *
 * The condition under test is one a running daemon reports as healthy: it boots
 * fine, answers /health 200, and every schema-dependent write fails. So the
 * assertions here are about what the BODY says and whether the gate actually
 * closes — a test that only checked the process was alive would reproduce the
 * bug rather than catch it.
 */
import { describe, test, expect, beforeEach } from "bun:test";

import {
  decideBehindTransitionSignal,
  getSchemaReadiness,
  isSchemaBehind,
  refreshSchemaReadiness,
  resetSchemaReadiness,
} from "./schema-readiness";

describe("schema readiness", () => {
  beforeEach(() => {
    resetSchemaReadiness();
  });

  test("starts unknown, not current", () => {
    // The initial state must not read as "current" — nothing has been checked,
    // and reporting an unchecked schema as up to date is the same class of
    // false reassurance this gate exists to remove.
    const readiness = getSchemaReadiness();
    expect(readiness.current).toBeNull();
    expect(readiness.checkedAt).toBeNull();
    expect(isSchemaBehind()).toBe(false);
  });

  test("reports current when nothing is pending", async () => {
    await refreshSchemaReadiness({ readPendingMigrations: async () => [] });

    const readiness = getSchemaReadiness();
    expect(readiness.current).toBe(true);
    expect(readiness.pending).toEqual([]);
    expect(readiness.checkedAt).not.toBeNull();
    expect(isSchemaBehind()).toBe(false);
  });

  test("reports behind, and names the pending migrations", async () => {
    await refreshSchemaReadiness({
      readPendingMigrations: async () => ["0076_cuddly_giant_girl"],
    });

    const readiness = getSchemaReadiness();
    expect(readiness.current).toBe(false);
    expect(readiness.pending).toEqual(["0076_cuddly_giant_girl"]);
    expect(isSchemaBehind()).toBe(true);
  });

  test("a failed check is unknown, and does NOT block work", async () => {
    // Fails open on purpose. A sweep must not be disabled because the readiness
    // check itself broke: running against a schema we could not verify costs
    // nothing when it is in fact current, whereas silently pausing capture on
    // an unknown is another quiet outage of the kind being fixed.
    await refreshSchemaReadiness({
      readPendingMigrations: async () => {
        throw new Error("connection refused");
      },
    });

    const readiness = getSchemaReadiness();
    expect(readiness.current).toBeNull();
    expect(readiness.unknownReason).toContain("connection refused");
    expect(isSchemaBehind()).toBe(false);
  });

  test("recovers without a restart once the migration is applied", async () => {
    // The recovery path an operator actually takes: apply the migration while
    // the daemon keeps running. If clearing required a restart, the gate would
    // turn a short window into a long one.
    await refreshSchemaReadiness({
      readPendingMigrations: async () => ["0076_pending"],
    });
    expect(isSchemaBehind()).toBe(true);

    await refreshSchemaReadiness({ readPendingMigrations: async () => [] });
    expect(isSchemaBehind()).toBe(false);
    expect(getSchemaReadiness().current).toBe(true);
  });

  test("an unknown result after a behind result clears the block", async () => {
    // Ordering matters: `unknownReason` replaces a previous verdict rather than
    // leaving a stale `current: false` behind, so a transient check failure
    // cannot pin the sweep off indefinitely.
    await refreshSchemaReadiness({
      readPendingMigrations: async () => ["0076_pending"],
    });
    expect(isSchemaBehind()).toBe(true);

    await refreshSchemaReadiness({
      readPendingMigrations: async () => {
        throw new Error("transient");
      },
    });
    expect(isSchemaBehind()).toBe(false);
    expect(getSchemaReadiness().current).toBeNull();
  });

  // PR #2379 R1: the gate runs on every sweep tick. A check whose stated
  // purpose is bounding log volume must not itself write a line every 30
  // minutes for as long as the condition lasts, so it logs the TRANSITION only.
  //
  // The dedup decision itself is a pure state machine (mt#3629 / mt#3565
  // §Reframe) — asserted directly by return value below, no spy required.
  describe("decideBehindTransitionSignal (pure core)", () => {
    test("signals only on the false -> true edge", () => {
      expect(decideBehindTransitionSignal(false, true)).toEqual({ shouldSignal: true });
    });

    test("stays quiet while behind persists", () => {
      expect(decideBehindTransitionSignal(true, true)).toEqual({ shouldSignal: false });
    });

    test("stays quiet on recovery (true -> false)", () => {
      expect(decideBehindTransitionSignal(true, false)).toEqual({ shouldSignal: false });
    });

    test("stays quiet while current persists", () => {
      expect(decideBehindTransitionSignal(false, false)).toEqual({ shouldSignal: false });
    });
  });

  // One wiring test: the shell forwards what the pure core decided to an
  // injected sink — no logger spy needed (mt#3629).
  test("wiring: refreshSchemaReadiness forwards the transition decision to the injected sink", async () => {
    const behindCalls: Array<{ message: string; pending: string[] }> = [];
    const recoveredCalls: string[] = [];
    const behind = {
      readPendingMigrations: async () => ["0076_pending"],
      logBehindTransition: (message: string, meta: { pending: string[] }) => {
        behindCalls.push({ message, pending: meta.pending });
      },
      logRecovered: (message: string) => {
        recoveredCalls.push(message);
      },
    };

    await refreshSchemaReadiness(behind);
    expect(behindCalls.length).toBe(1);
    expect(behindCalls[0]?.pending).toEqual(["0076_pending"]);

    // Three more ticks with the condition unchanged — no further sink calls.
    await refreshSchemaReadiness(behind);
    await refreshSchemaReadiness(behind);
    await refreshSchemaReadiness(behind);
    expect(behindCalls.length).toBe(1);
    expect(isSchemaBehind()).toBe(true);

    // Recovering emits the recovery sink, once.
    await refreshSchemaReadiness({
      readPendingMigrations: async () => [],
      logBehindTransition: behind.logBehindTransition,
      logRecovered: behind.logRecovered,
    });
    expect(recoveredCalls.length).toBe(1);

    // Regressing warns again: this is a new event.
    await refreshSchemaReadiness(behind);
    expect(behindCalls.length).toBe(2);
  });

  test("the snapshot is a copy — callers cannot mutate the gate", async () => {
    await refreshSchemaReadiness({
      readPendingMigrations: async () => ["0076_pending"],
    });

    const snapshot = getSchemaReadiness();
    snapshot.pending.push("injected");
    snapshot.current = true;

    expect(getSchemaReadiness().pending).toEqual(["0076_pending"]);
    expect(isSchemaBehind()).toBe(true);
  });
});
