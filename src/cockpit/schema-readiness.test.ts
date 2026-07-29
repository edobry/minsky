/**
 * Tests for the schema-readiness gate (mt#3297).
 *
 * The condition under test is one a running daemon reports as healthy: it boots
 * fine, answers /health 200, and every schema-dependent write fails. So the
 * assertions here are about what the BODY says and whether the gate actually
 * closes — a test that only checked the process was alive would reproduce the
 * bug rather than catch it.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";

import { log } from "@minsky/shared/logger";

import {
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
  test("warns on entering the behind state, then stays quiet while it persists", async () => {
    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const behind = { readPendingMigrations: async () => ["0076_pending"] };

      await refreshSchemaReadiness(behind);
      const afterFirst = warnSpy.mock.calls.length;
      expect(afterFirst).toBe(1);

      // Three more ticks with the condition unchanged.
      await refreshSchemaReadiness(behind);
      await refreshSchemaReadiness(behind);
      await refreshSchemaReadiness(behind);
      expect(warnSpy.mock.calls.length).toBe(afterFirst);

      // Still reported as behind throughout — quiet is not the same as clear.
      expect(isSchemaBehind()).toBe(true);

      // Recovering and regressing warns again: this is a new event.
      await refreshSchemaReadiness({ readPendingMigrations: async () => [] });
      await refreshSchemaReadiness(behind);
      expect(warnSpy.mock.calls.length).toBe(afterFirst + 1);
    } finally {
      warnSpy.mockRestore();
    }
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
