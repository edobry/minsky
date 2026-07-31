/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O (cache write + read-back) IS the contract here */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildProdStateSnapshot,
  writeProdStateCache,
  refreshProdStateCache,
  type UnsafeSql,
  type ProdStateCacheRecord,
} from "./prod-state-cache";
import { ProdStateSweepTracker } from "./prod-state-sweep-tracker";
import { createIntervalSweeper, _resetSweepLivenessRegistryForTest } from "./sweepers";

const okSql: UnsafeSql = { unsafe: async () => [{ total: 48, latest_at: "1718500000000" }] };
const emptySql: UnsafeSql = { unsafe: async () => [] };
const throwSql: UnsafeSql = {
  unsafe: async () => {
    throw new Error("relation drizzle.__drizzle_migrations does not exist");
  },
};

const tmpPath = path.join(
  os.tmpdir(),
  `minsky-prod-state-${process.pid}-${crypto.randomUUID()}.json`
);

/** Poll `condition` until it's true, or throw after `timeoutMs` — mirrors sweepers.test.ts's helper. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  ProdStateSweepTracker.resetForTest();
});

afterEach(() => {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* ignore */
  }
});

describe("buildProdStateSnapshot", () => {
  test("reads ledger count + latest-applied timestamp", async () => {
    const snap = await buildProdStateSnapshot(okSql);
    expect(snap).toEqual({ ledgerRows: 48, latestAppliedAtMs: 1718500000000 });
  });

  test("empty ledger result -> null (caller fails open)", async () => {
    expect(await buildProdStateSnapshot(emptySql)).toBeNull();
  });

  test("unreadable ledger (throws) -> null", async () => {
    expect(await buildProdStateSnapshot(throwSql)).toBeNull();
  });

  test("null latest_at -> null latestAppliedAtMs", async () => {
    const sql: UnsafeSql = { unsafe: async () => [{ total: 0, latest_at: null }] };
    const snap = await buildProdStateSnapshot(sql);
    expect(snap).toEqual({ ledgerRows: 0, latestAppliedAtMs: null });
  });
});

describe("writeProdStateCache", () => {
  test("writes a parseable cache record with the injected checkedAt", () => {
    const ok = writeProdStateCache(
      { ledgerRows: 48, latestAppliedAtMs: 1718500000000 },
      "2026-06-16T20:00:00.000Z",
      tmpPath
    );
    expect(ok).toBe(true);
    const parsed = JSON.parse(String(fs.readFileSync(tmpPath, "utf-8"))) as ProdStateCacheRecord;
    expect(parsed).toEqual({
      ledgerRows: 48,
      latestAppliedAtMs: 1718500000000,
      checkedAt: "2026-06-16T20:00:00.000Z",
    });
  });
});

describe("refreshProdStateCache", () => {
  test("null sql -> false, no cache written (last-good preserved)", async () => {
    const ok = await refreshProdStateCache(null, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test("unreadable ledger -> false, no cache written", async () => {
    const ok = await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test("good sql -> true, cache written from the live ledger", async () => {
    const ok = await refreshProdStateCache(okSql, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(true);
    const parsed = JSON.parse(String(fs.readFileSync(tmpPath, "utf-8"))) as ProdStateCacheRecord;
    expect(parsed.ledgerRows).toBe(48);
    expect(parsed.checkedAt).toBe("2026-06-16T20:00:00.000Z");
  });
});

// ── mt#3039: ProdStateSweepTracker integration ─────────────────────────────

describe("refreshProdStateCache -> ProdStateSweepTracker integration (mt#3039 SC3)", () => {
  test("a successful refresh records a run + a success, resetting consecutiveFailures", async () => {
    ProdStateSweepTracker.getInstance().recordFailure();
    ProdStateSweepTracker.getInstance().recordFailure();

    const ok = await refreshProdStateCache(okSql, "2026-06-16T20:00:00.000Z", tmpPath);
    expect(ok).toBe(true);

    const s = ProdStateSweepTracker.getInstance().getSummary();
    expect(s.runsCount).toBe(1);
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });

  test("a null-sql failure is recorded as a run + a failure (SC2: no longer silent)", async () => {
    await refreshProdStateCache(null, "2026-06-16T20:00:00.000Z", tmpPath);
    const s = ProdStateSweepTracker.getInstance().getSummary();
    expect(s.runsCount).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastErrorAt).not.toBeNull();
    expect(s.lastSuccessAt).toBeNull();
  });

  test("an unreadable-ledger failure is recorded as a run + a failure (SC2: no longer silent)", async () => {
    await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
    const s = ProdStateSweepTracker.getInstance().getSummary();
    expect(s.runsCount).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastErrorAt).not.toBeNull();
  });

  test("a persistent failure across repeated calls keeps incrementing consecutiveFailures without terminating (mt#3039 SC1)", async () => {
    for (let i = 0; i < 4; i++) {
      const ok = await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
      expect(ok).toBe(false);
    }
    const s = ProdStateSweepTracker.getInstance().getSummary();
    expect(s.runsCount).toBe(4);
    expect(s.consecutiveFailures).toBe(4);
  });

  test("a later success after failures resets consecutiveFailures to 0 (sane values under normal operation — acceptance test 2)", async () => {
    await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
    await refreshProdStateCache(throwSql, "2026-06-16T20:00:00.000Z", tmpPath);
    await refreshProdStateCache(okSql, "2026-06-16T20:00:00.000Z", tmpPath);

    const s = ProdStateSweepTracker.getInstance().getSummary();
    expect(s.runsCount).toBe(3);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.lastErrorAt).not.toBeNull(); // the earlier failures are still remembered
  });
});

// ── mt#3039 SC1 / acceptance test 1: the recurring sweep loop survives ─────
// per-tick refresh errors — a persistently-failing tick must not terminate
// the interval; the next tick still fires and each failure is counted.

describe("recurring sweep loop survives per-tick refresh errors (mt#3039 SC1, acceptance test 1)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  test("a persistently-failing refresh keeps ticking on cadence; each tick is counted, none crash the loop", async () => {
    let tickCount = 0;
    const stop = createIntervalSweeper({
      name: "test-prod-state-persistent-failure",
      intervalMs: 10,
      tickTimeoutMs: 5_000,
      tick: async () => {
        tickCount++;
        // Mirrors startProdStateRefreshSweeper's tick body: refreshProdStateCache
        // never throws (fail-open), so the interval-scheduling layer sees every
        // one of these as a "successful" tick even though the domain write
        // always fails — this is exactly the gap ProdStateSweepTracker closes.
        await refreshProdStateCache(throwSql, new Date().toISOString(), tmpPath);
      },
    });

    try {
      // If a per-tick failure could terminate the loop, tickCount would stay
      // at 1 forever. Recovery/survival means MULTIPLE ticks actually run.
      await waitFor(() => tickCount >= 3, 2000);
      expect(tickCount).toBeGreaterThanOrEqual(3);

      const s = ProdStateSweepTracker.getInstance().getSummary();
      // Every tick that ran called refreshProdStateCache, and every one failed
      // (throwSql) — so the tracker's counts should track tickCount 1:1, and
      // the failure is COUNTED (not silently dropped) on each one.
      expect(s.runsCount).toBeGreaterThanOrEqual(3);
      expect(s.consecutiveFailures).toBeGreaterThanOrEqual(3);
      expect(s.lastSuccessAt).toBeNull();
      expect(fs.existsSync(tmpPath)).toBe(false);
    } finally {
      stop();
    }
  });

  test("a run of failures followed by a success is fully reflected — the loop self-recovers once the read succeeds again", async () => {
    let tickCount = 0;
    let sql: UnsafeSql = throwSql;
    const stop = createIntervalSweeper({
      name: "test-prod-state-recovers",
      intervalMs: 10,
      tickTimeoutMs: 5_000,
      tick: async () => {
        tickCount++;
        if (tickCount === 3) sql = okSql; // simulate the read recovering
        await refreshProdStateCache(sql, new Date().toISOString(), tmpPath);
      },
    });

    try {
      await waitFor(
        () => ProdStateSweepTracker.getInstance().getSummary().lastSuccessAt !== null,
        2000
      );
      const s = ProdStateSweepTracker.getInstance().getSummary();
      expect(s.lastSuccessAt).not.toBeNull();
      expect(s.consecutiveFailures).toBe(0);
      expect(fs.existsSync(tmpPath)).toBe(true);
    } finally {
      stop();
    }
  });
});
