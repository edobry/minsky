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
  createProdStateTouchRefresher,
  waitForPersistenceReady,
  triggerProdStateBootRefreshWhenReady,
  PROD_STATE_BOOT_STALENESS_MS,
  type ProdStateBootRefreshDeps,
  type PersistenceAwareContainer,
} from "./prod-state-boot-refresh";
import { PROD_STATE_REFRESH_INTERVAL_MS } from "../cockpit/sweepers";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

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

  test("the skip and the refresh go to SEPARATE sinks (PR #2805 R1)", async () => {
    // The two events have very different frequencies — ~100 skips a day under a healthy daemon
    // vs a refresh that means the daemon was NOT keeping the cache fresh — so they must be
    // separately routable, which is what lets the defaults be debug and info respectively.
    // The defaults themselves are a one-line read of the code; ADR-036 bans patching the
    // logger to observe them.
    const skips: string[] = [];
    const infos: string[] = [];
    const base = {
      now: () => NOW_MS,
      resolveRawSql: async () => async () => ({ sql: "stub" }),
      refresh: async () => true,
      logSkip: (message: string) => skips.push(message),
      logInfo: (message: string) => infos.push(message),
      logWarn: () => {},
    };

    await runProdStateBootRefresh({ ...base, readCache: () => cacheAged(60_000) });
    expect(skips).toHaveLength(1);
    expect(infos).toHaveLength(0);

    await runProdStateBootRefresh({ ...base, readCache: () => null });
    expect(skips).toHaveLength(1);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("refreshed prod-state cache at boot");
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

/**
 * Tests for the tool-path trigger (mt#4938 SC1) and the persistence-ready ordering fix
 * (SC2). Same injected-deps discipline as above — a mutable `cacheState` closure variable
 * stands in for the real cache file, and `flush()` lets the fire-and-forget refresh promise
 * chain settle before assertions run.
 */

/** Advance past pending microtasks/timers so a fire-and-forget `touch()` call settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A `ProdStateBootRefreshDeps` backed by a mutable in-memory "cache file". */
function touchDeps(
  initialAgeMs: number,
  overrides: Partial<ProdStateBootRefreshDeps> = {}
): {
  deps: ProdStateBootRefreshDeps;
  refreshCount: () => number;
  resolveRawSqlCount: () => number;
  infos: string[];
  warns: string[];
  skips: string[];
} {
  let cacheContents: string | null = cacheAged(initialAgeMs);
  let refreshCount = 0;
  let resolveRawSqlCount = 0;
  const infos: string[] = [];
  const warns: string[] = [];
  const skips: string[] = [];

  const deps: ProdStateBootRefreshDeps = {
    readCache: () => cacheContents,
    resolveRawSql: async () => {
      resolveRawSqlCount += 1;
      return async () => ({ sql: "stub" });
    },
    refresh: async (_sql, nowIso) => {
      refreshCount += 1;
      cacheContents = JSON.stringify({
        ledgerRows: 93,
        latestAppliedAtMs: Date.parse(nowIso) - 60_000,
        checkedAt: nowIso,
      });
      return true;
    },
    logInfo: (message) => infos.push(message),
    logWarn: (message) => warns.push(message),
    logSkip: (message) => skips.push(message),
    ...overrides,
  };

  return {
    deps,
    refreshCount: () => refreshCount,
    resolveRawSqlCount: () => resolveRawSqlCount,
    infos,
    warns,
    skips,
  };
}

describe("createProdStateTouchRefresher", () => {
  test("AT1: three touches within one second against a stale cache start exactly one refresh", async () => {
    const h = touchDeps(PROD_STATE_BOOT_STALENESS_MS + 1);
    const refresher = createProdStateTouchRefresher(h.deps);

    refresher.touch(NOW_MS);
    refresher.touch(NOW_MS + 300);
    refresher.touch(NOW_MS + 900);
    await flush();

    expect(h.refreshCount()).toBe(1);
    expect(h.infos).toHaveLength(1);
    expect(h.infos[0]).toContain("refreshed prod-state cache (tool-path)");
  });

  test("AT1: a 5-minute-old cache never touches the ledger", async () => {
    const h = touchDeps(5 * 60_000);
    const refresher = createProdStateTouchRefresher(h.deps);

    refresher.touch(NOW_MS);
    await flush();

    expect(h.resolveRawSqlCount()).toBe(0);
    expect(h.refreshCount()).toBe(0);
    expect(h.skips).toHaveLength(1);
    expect(h.infos).toHaveLength(0);
  });

  test("AT2: refreshes again 21 minutes after the last write; a touch at 19 minutes does not", async () => {
    const h = touchDeps(PROD_STATE_BOOT_STALENESS_MS + 1);
    const refresher = createProdStateTouchRefresher(h.deps);

    refresher.touch(NOW_MS);
    await flush();
    expect(h.refreshCount()).toBe(1);

    // The debounce window (60s) is long past by 19 minutes, but the cache the first
    // refresh just wrote is only 19 minutes old — still fresh relative to the 20-minute bar.
    refresher.touch(NOW_MS + 19 * 60_000);
    await flush();
    expect(h.refreshCount()).toBe(1);

    // 21 minutes after the write: stale again.
    refresher.touch(NOW_MS + 21 * 60_000);
    await flush();
    expect(h.refreshCount()).toBe(2);
  });

  test("single-flight: a touch while a refresh is still in flight is a no-op, even past the debounce window", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCount = 0;
    const refresher = createProdStateTouchRefresher({
      readCache: () => cacheAged(PROD_STATE_BOOT_STALENESS_MS + 1),
      resolveRawSql: async () => async () => ({ sql: "stub" }),
      refresh: async () => {
        await refreshGate;
        refreshCount += 1;
        return true;
      },
      logInfo: () => {},
      logWarn: () => {},
      logSkip: () => {},
    });

    refresher.touch(NOW_MS);
    // Past the 60s debounce window, but the first refresh has not settled yet.
    refresher.touch(NOW_MS + 120_000);
    expect(refreshCount).toBe(0);

    releaseRefresh?.();
    await flush();
    expect(refreshCount).toBe(1);
  });

  test("an exception from readCache is warn-logged and swallowed, not thrown", () => {
    const warns: string[] = [];
    const refresher = createProdStateTouchRefresher({
      readCache: () => {
        throw new Error("disk on fire");
      },
      // Never reached in this test — asserting only the synchronous read-failure path.
      resolveRawSql: async () => async () => ({ sql: "stub" }),
      refresh: async () => true,
      logInfo: () => {},
      logWarn: (message) => warns.push(message),
      logSkip: () => {},
    });

    expect(() => refresher.touch(NOW_MS)).not.toThrow();
    expect(warns.some((w) => w.includes("cache read failed"))).toBe(true);
  });

  test("PR #3615 R1 BLOCKING: a throwing readCache is treated as unreadable (refresh), not a 60s suppression", async () => {
    // Reviewer finding on review 5110643884: `lastDecisionAtMs` was advanced BEFORE the
    // decision was produced, so a thrown `readCache()` (permissions, a torn file, an ENOENT
    // race with the cockpit's atomic rename) suppressed every touch for a full debounce
    // window without ever having decided anything — a silent blind spot where a stale cache
    // could not be refreshed. Fix: treat the thrown read the same way
    // `decideProdStateBootRefresh` already treats a parse failure — "unreadable" -> refresh —
    // and only advance the debounce clock once a decision (real or synthesized) exists.
    let readCalls = 0;
    let cacheContents: string | null = null;
    let refreshCount = 0;
    const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const infos: string[] = [];

    const refresher = createProdStateTouchRefresher({
      readCache: () => {
        readCalls += 1;
        if (readCalls === 1) {
          throw new Error("EACCES: permission denied, open '/tmp/prod-state-cache.json'");
        }
        return cacheContents;
      },
      resolveRawSql: async () => async () => ({ sql: "stub" }),
      refresh: async (_sql, nowIso) => {
        refreshCount += 1;
        cacheContents = JSON.stringify({
          ledgerRows: 1,
          latestAppliedAtMs: Date.parse(nowIso) - 60_000,
          checkedAt: nowIso,
        });
        return true;
      },
      logInfo: (message) => infos.push(message),
      logWarn: (message, meta) => warns.push({ message, meta }),
      logSkip: () => {},
    });

    // First touch: readCache() throws. Must not throw out of touch(), must be routed
    // through the decision path as "unreadable" (a refresh is warranted, not a suppressed
    // debounce window), and the read failure must be logged at warn via
    // getLoggableErrorSummary (the error text lands in the log META, not the message —
    // matching every other warn call in this module).
    expect(() => refresher.touch(NOW_MS)).not.toThrow();
    await flush();
    expect(refreshCount).toBe(1);
    expect(infos.some((m) => m.includes("refreshed prod-state cache (tool-path)"))).toBe(true);
    expect(
      warns.some(
        (w) => w.message.includes("cache read failed") && String(w.meta?.error).includes("EACCES")
      )
    ).toBe(true);

    // One second later: the cache the first refresh just wrote is fresh. This must NOT
    // refresh again — confirming the normal freshness rule governs once a decision exists,
    // not a blanket 60s block that was never actually earned by a real decision.
    refresher.touch(NOW_MS + 1_000);
    await flush();
    expect(refreshCount).toBe(1);

    // 21 minutes after the write, the cache is genuinely stale again — a normal refresh,
    // confirming the trigger recovered fully rather than being permanently wedged.
    refresher.touch(NOW_MS + 21 * 60_000);
    await flush();
    expect(refreshCount).toBe(2);
  });
});

/** Minimal fake satisfying {@link PersistenceAwareContainer}. */
function fakeContainer(opts: {
  readyAfterCalls?: number;
  neverReady?: boolean;
}): PersistenceAwareContainer & { hasCalls: () => number } {
  let calls = 0;
  const readyAfterCalls = opts.readyAfterCalls ?? 0;
  const fakePersistence = {} as BasePersistenceProvider;
  return {
    has: () => {
      calls += 1;
      if (opts.neverReady) return false;
      return calls > readyAfterCalls;
    },
    get: () => fakePersistence,
    hasCalls: () => calls,
  };
}

describe("waitForPersistenceReady", () => {
  test("resolves true as soon as has() reports ready, without exhausting the timeout", async () => {
    const container = fakeContainer({ readyAfterCalls: 2 });
    const sleeps: number[] = [];
    const ready = await waitForPersistenceReady(container, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ready).toBe(true);
    // Polled until ready — bounded by readyAfterCalls, nowhere near the 10s timeout budget.
    expect(sleeps.length).toBeLessThan(5);
  });

  test("resolves false once the timeout elapses and persistence never becomes available", async () => {
    // Small, real bound (10ms) so this test's wall-clock cost stays negligible — the injected
    // `sleep` below resolves instantly rather than actually delaying, so the loop spins on the
    // REAL clock until `timeoutMs` has genuinely elapsed.
    const container = fakeContainer({ neverReady: true });
    let sleepCalls = 0;
    const ready = await waitForPersistenceReady(container, {
      pollIntervalMs: 1,
      timeoutMs: 10,
      sleep: async () => {
        sleepCalls += 1;
      },
    });
    expect(ready).toBe(false);
    expect(sleepCalls).toBeGreaterThan(0);
  });

  test("PR #3615 R2: an already-aborted signal returns false promptly, without exhausting the timeout", async () => {
    // The shutdown/abort path (mt#4938 PR #3615 R2): a process on its way out should not make
    // this best-effort wait run to its full budget. A LONG timeoutMs (10s) proves the early
    // return is the abort check, not the timeout — the timeout is never actually reached
    // (sleepCalls stays 0, since the FIRST loop iteration's has()-then-abort check exits
    // before ever calling sleep).
    const container = fakeContainer({ neverReady: true });
    const controller = new AbortController();
    controller.abort();
    let sleepCalls = 0;
    const ready = await waitForPersistenceReady(container, {
      timeoutMs: 10_000,
      signal: controller.signal,
      sleep: async () => {
        sleepCalls += 1;
      },
    });
    expect(ready).toBe(false);
    expect(sleepCalls).toBe(0);
  });

  test("PR #3615 R2: aborting mid-poll stops the wait on the NEXT loop check, without reaching the timeout", async () => {
    const container = fakeContainer({ neverReady: true });
    const controller = new AbortController();
    let sleepCalls = 0;
    const ready = await waitForPersistenceReady(container, {
      timeoutMs: 10_000,
      signal: controller.signal,
      sleep: async () => {
        sleepCalls += 1;
        // Abort partway through — the wait must notice on its NEXT iteration rather than
        // running out the full (10s) timeout.
        if (sleepCalls === 3) controller.abort();
      },
    });
    expect(ready).toBe(false);
    // Exactly the sleeps needed to reach the abort, plus none after — proves the loop checks
    // `signal.aborted` on every iteration rather than only once at entry.
    expect(sleepCalls).toBe(3);
  });

  test("PR #3615 R2: the default sleep's timer is unref()'d, so a pending wait cannot hold the process open", async () => {
    // Cannot observe "does the process exit" from inside the SAME process's test — instead
    // assert the CONTRACT this relies on: the timer handle returned by the real (non-injected)
    // sleep path has `unref` called on it. A fake global `setTimeout` captures the handle and
    // reports whether `.unref()` was invoked, without needing a real timer to fire.
    const realSetTimeout = globalThis.setTimeout;
    let unrefCalled = false;
    // @ts-expect-error -- intentionally narrowing the global for one call, restored in finally.
    globalThis.setTimeout = (fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms);
      const originalUnref = handle.unref?.bind(handle);
      // Wrap rather than replace outright, so the real timer behavior (still fires) is
      // preserved — this test only needs to know unref() was CALLED, not stub it out.
      (handle as unknown as { unref: () => void }).unref = () => {
        unrefCalled = true;
        originalUnref?.();
      };
      return handle;
    };
    try {
      const container = fakeContainer({ readyAfterCalls: 1 });
      await waitForPersistenceReady(container, { pollIntervalMs: 1 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(unrefCalled).toBe(true);
  });
});

describe("triggerProdStateBootRefreshWhenReady (mt#4938 SC2)", () => {
  test(
    'Negative control: calling container.get("persistence") before it is registered ' +
      "reproduces the observed 'Service is not available' failure",
    () => {
      // Mirrors TsyringeContainer.get()'s real behavior (packages/domain/src/composition/
      // container.ts) for a key that has not been registered yet — the exact shape recorded
      // in this module's doc comment (8 occurrences in the daemon log). This is what the
      // UNPATCHED start-command.ts call site did: `container.get("persistence")` with no
      // wait, immediately inside the fire-and-forget `.then()`.
      const container: Pick<PersistenceAwareContainer, "get"> = {
        get: () => {
          throw new Error(
            'Service "persistence" is not available. Call initialize() first or use set() to provide an instance.'
          );
        },
      };
      expect(() => container.get("persistence")).toThrow('Service "persistence" is not available');
    }
  );

  test("persistence resolving late still yields exactly one refresh, with no thrown/caught failure", async () => {
    const container = fakeContainer({ readyAfterCalls: 3 });
    let refreshCalls = 0;
    // triggerProdStateBootRefresh itself is exercised through the real module (not re-mocked
    // here) via the container's real `get()`; substitute a persistence provider whose
    // getRawSqlConnection is absent so the tick reports a clean, deterministic failure
    // (`ok: false`) rather than reaching a real database — the point of this test is the
    // WAIT, not the refresh outcome.
    (container as { get: PersistenceAwareContainer["get"] }).get = () => {
      refreshCalls += 1;
      return {} as BasePersistenceProvider;
    };

    const result = await triggerProdStateBootRefreshWhenReady(container, "/tmp/does-not-exist", {
      pollIntervalMs: 1,
    });
    expect(result).not.toBeNull();
    expect(refreshCalls).toBe(1);
  });

  test("gives up cleanly (returns null, never throws) when persistence never becomes available", async () => {
    const container = fakeContainer({ neverReady: true });
    const result = await triggerProdStateBootRefreshWhenReady(container, undefined, {
      pollIntervalMs: 1,
      timeoutMs: 10,
    });
    expect(result).toBeNull();
  });
});
