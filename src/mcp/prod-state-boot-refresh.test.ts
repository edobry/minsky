/**
 * Tests for the prod-state boot refresh (mt#3922).
 *
 * Every case here injects its dependencies rather than patching `fs`, the logger, or
 * `./prod-state-cache` — the decision half is a pure function of (raw contents, clock) and the
 * shell takes its IO as parameters, per `testing-standards.mdc §Testable Design` and ADR-036's
 * ban on module patching.
 *
 * AT4 (concurrent writers cannot produce a torn read) is deliberately NOT here. Tearing is a
 * cross-PROCESS phenomenon: within one single-threaded process reads and writes cannot
 * interleave at all, so an in-process "concurrency" test passes whether or not the write is
 * atomic — a probe that returns the same answer when the system is broken (mem#704). Its
 * evidence is `scripts/verify-prod-state-cache-atomicity.ts`, which spawns a real second
 * process and carries its own negative control.
 */
import { describe, expect, test } from "bun:test";
import {
  decideProdStateBootRefresh,
  runProdStateBootRefresh,
  PROD_STATE_BOOT_STALENESS_MS,
} from "./prod-state-boot-refresh";
import { PROD_STATE_REFRESH_INTERVAL_MS } from "../cockpit/sweepers";

const NOW_MS = Date.parse("2026-08-10T12:00:00.000Z");

/** Cache contents whose `checkedAt` is `ageMs` old relative to {@link NOW_MS}. */
function cacheAged(ageMs: number): string {
  return JSON.stringify({
    ledgerRows: 93,
    latestAppliedAtMs: NOW_MS - 60_000,
    checkedAt: new Date(NOW_MS - ageMs).toISOString(),
  });
}

/** Deps whose refresh always succeeds. */
function succeedingDeps(
  readCache: () => string | null
): Parameters<typeof runProdStateBootRefresh>[0] {
  return {
    readCache,
    now: () => NOW_MS,
    resolveRawSql: async () => async () => ({ sql: "stub" }),
    refresh: async () => true,
    logInfo: () => {},
    logWarn: () => {},
  };
}

describe("PROD_STATE_BOOT_STALENESS_MS", () => {
  // The consumer's own STALE bar, `PROD_STATE_STALENESS_MS` in
  // `.minsky/hooks/inject-prod-state.ts:44`. Duplicated as a literal rather than imported:
  // the hook lives in a separate tsconfig project and module graph (the same reason
  // `prod-state-cache.ts` duplicates the cache filename), so an import would couple the two
  // build graphs to assert a bound.
  const CONSUMER_STALE_BAR_MS = 30 * 60 * 1000;

  test("sits strictly between the daemon's cadence and the consumer's STALE bar", () => {
    // Above the cadence: a boot under a healthy daemon must not refresh, or ~100 restarts a
    // day become ~100 ledger reads a day.
    expect(PROD_STATE_BOOT_STALENESS_MS).toBeGreaterThan(PROD_STATE_REFRESH_INTERVAL_MS);
    // Below the consumer's bar: the backstop must fire before the injection hook starts
    // telling every turn the snapshot is stale.
    expect(PROD_STATE_BOOT_STALENESS_MS).toBeLessThan(CONSUMER_STALE_BAR_MS);
  });

  test("is derived from the daemon cadence, not an independent number", () => {
    expect(PROD_STATE_BOOT_STALENESS_MS % PROD_STATE_REFRESH_INTERVAL_MS).toBe(0);
  });
});

describe("decideProdStateBootRefresh", () => {
  test("refreshes when the cache is absent", () => {
    expect(decideProdStateBootRefresh(null, NOW_MS)).toEqual({
      refresh: true,
      reason: "absent",
      ageMs: null,
    });
  });

  test("refreshes when the cache is not valid JSON", () => {
    expect(decideProdStateBootRefresh("{not json", NOW_MS)).toEqual({
      refresh: true,
      reason: "unreadable",
      ageMs: null,
    });
  });

  test("refreshes when the record carries no usable checkedAt", () => {
    expect(decideProdStateBootRefresh(JSON.stringify({ ledgerRows: 1 }), NOW_MS).reason).toBe(
      "unreadable"
    );
    expect(
      decideProdStateBootRefresh(JSON.stringify({ checkedAt: "not-a-date" }), NOW_MS).reason
    ).toBe("unreadable");
  });

  test("does NOT refresh a cache younger than the threshold", () => {
    const decision = decideProdStateBootRefresh(cacheAged(60_000), NOW_MS);
    expect(decision.refresh).toBe(false);
    expect(decision.reason).toBe("fresh");
    expect(decision.ageMs).toBe(60_000);
  });

  test("refreshes a cache older than the threshold", () => {
    const decision = decideProdStateBootRefresh(
      cacheAged(PROD_STATE_BOOT_STALENESS_MS + 1),
      NOW_MS
    );
    expect(decision.refresh).toBe(true);
    expect(decision.reason).toBe("stale");
  });

  test("treats exactly-at-threshold as fresh (strict >)", () => {
    expect(
      decideProdStateBootRefresh(cacheAged(PROD_STATE_BOOT_STALENESS_MS), NOW_MS).refresh
    ).toBe(false);
  });

  test("treats a future-dated checkedAt as fresh rather than stale", () => {
    // Clock skew between the two writers must not make every boot refresh.
    const decision = decideProdStateBootRefresh(cacheAged(-5 * 60_000), NOW_MS);
    expect(decision.refresh).toBe(false);
    expect(decision.ageMs).toBe(-5 * 60_000);
  });
});

describe("runProdStateBootRefresh", () => {
  test("AT2: a fresh cache is not refreshed, and an aged one is (negative control)", async () => {
    const freshResult = await runProdStateBootRefresh(succeedingDeps(() => cacheAged(60_000)));
    expect(freshResult.wrote).toBeNull();
    expect(freshResult.decision.reason).toBe("fresh");

    const agedResult = await runProdStateBootRefresh(
      succeedingDeps(() => cacheAged(PROD_STATE_BOOT_STALENESS_MS + 1))
    );
    expect(agedResult.wrote).toBe(true);
    expect(agedResult.decision.reason).toBe("stale");
  });

  test("AT1: an absent cache is refreshed", async () => {
    const result = await runProdStateBootRefresh(succeedingDeps(() => null));
    expect(result.decision.reason).toBe("absent");
    expect(result.wrote).toBe(true);
  });

  test("AT3: an unreachable DB completes without throwing and writes nothing", async () => {
    const warnings: string[] = [];
    const result = await runProdStateBootRefresh({
      readCache: () => cacheAged(PROD_STATE_BOOT_STALENESS_MS + 1),
      now: () => NOW_MS,
      resolveRawSql: async () => {
        throw new Error("getaddrinfo ENOTFOUND db.example");
      },
      refresh: async () => {
        throw new Error("refresh must not be reached when SQL cannot be resolved");
      },
      logInfo: () => {},
      logWarn: (message) => warnings.push(message),
    });
    expect(result.wrote).toBe(false);
    expect(warnings.some((w) => w.includes("prod-state refresh sweep failed"))).toBe(true);
  });

  test("a provider exposing no raw SQL is a reported failure, not a silent skip", async () => {
    const warnings: string[] = [];
    const result = await runProdStateBootRefresh({
      readCache: () => null,
      now: () => NOW_MS,
      resolveRawSql: async () => null,
      refresh: async () => {
        throw new Error("refresh must not be reached without a raw-SQL connection");
      },
      logInfo: () => {},
      logWarn: (message) => warnings.push(message),
    });
    expect(result.wrote).toBe(false);
    expect(warnings.some((w) => w.includes("no raw SQL connection"))).toBe(true);
  });

  test("a refresh that declines to write is reported, not counted as success", async () => {
    const warnings: string[] = [];
    const result = await runProdStateBootRefresh({
      readCache: () => null,
      now: () => NOW_MS,
      resolveRawSql: async () => async () => ({ sql: "stub" }),
      refresh: async () => false,
      logInfo: () => {},
      logWarn: (message) => warnings.push(message),
    });
    expect(result.wrote).toBe(false);
    expect(warnings.some((w) => w.includes("did not write"))).toBe(true);
  });
});
