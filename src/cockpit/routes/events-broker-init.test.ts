/**
 * SSE broker init concurrency + retry semantics (mt#2699).
 *
 * The broker init moved from pre-bind (where it gated the cockpit's port
 * bind on the ~5 s persistence init) to a post-bind background warmup that
 * can race early /api/events clients. These tests pin the promise-caching
 * contract that makes the race safe:
 *
 *   1. Concurrent callers share ONE init (no duplicate provider init / no
 *      leaked Postgres LISTEN connection).
 *   2. A failed init (resolved null) is NOT cached — the next caller retries.
 *   3. A successful init IS cached — later callers pay nothing.
 *
 * Uses the provider-factory seam (no mock.module — that persists across
 * bun:test files and would poison other suites, per the
 * shared-persistence.test.ts convention). The injected provider has no
 * `getListenCapableSqlConnection`, so init takes the documented
 * no-op-listener path — real SseBroker, no Postgres.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getServerSseBrokerForWidget,
  runSseBrokerWarmup,
  __resetServerSseBrokerForTests,
  __setSseBrokerProviderFactoryForTests,
} from "./events";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SSE broker init (mt#2699 post-bind warmup contract)", () => {
  beforeEach(() => {
    __resetServerSseBrokerForTests();
  });

  afterEach(() => {
    __setSseBrokerProviderFactoryForTests(null);
    __resetServerSseBrokerForTests();
  });

  test("concurrent callers share one init and one broker instance", async () => {
    let providerCalls = 0;
    __setSseBrokerProviderFactoryForTests(async () => {
      providerCalls++;
      await sleep(20); // hold the init in flight so both callers overlap
      return {}; // no getListenCapableSqlConnection -> no-op listener path
    });

    const [a, b] = await Promise.all([
      getServerSseBrokerForWidget(),
      getServerSseBrokerForWidget(),
    ]);

    expect(providerCalls).toBe(1);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("failed init is not cached — next caller retries and succeeds", async () => {
    let providerCalls = 0;
    let failFirst = true;
    __setSseBrokerProviderFactoryForTests(async () => {
      providerCalls++;
      if (failFirst) {
        failFirst = false;
        throw new Error("simulated connect failure");
      }
      return {};
    });

    const first = await getServerSseBrokerForWidget();
    expect(first).toBeNull();

    const second = await getServerSseBrokerForWidget();
    expect(second).not.toBeNull();
    expect(providerCalls).toBe(2);
  });

  test("successful init is cached — later callers do not re-init", async () => {
    let providerCalls = 0;
    __setSseBrokerProviderFactoryForTests(async () => {
      providerCalls++;
      return {};
    });

    const first = await getServerSseBrokerForWidget();
    const second = await getServerSseBrokerForWidget();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(providerCalls).toBe(1);
  });
});

describe("runSseBrokerWarmup — PR #1860 R1 (logged, bounded retry)", () => {
  beforeEach(() => {
    __resetServerSseBrokerForTests();
  });

  afterEach(() => {
    __setSseBrokerProviderFactoryForTests(null);
    __resetServerSseBrokerForTests();
  });

  test("retries failed init on the schedule and reports success", async () => {
    let providerCalls = 0;
    __setSseBrokerProviderFactoryForTests(async () => {
      providerCalls++;
      if (providerCalls < 3) throw new Error("simulated connect failure");
      return {};
    });

    const ok = await runSseBrokerWarmup([0, 0, 0, 0]);

    expect(ok).toBe(true);
    expect(providerCalls).toBe(3);
    // The broker is now cached for everyone else.
    expect(await getServerSseBrokerForWidget()).not.toBeNull();
    expect(providerCalls).toBe(3);
  });

  test("gives up after the schedule is exhausted — per-request retry remains available", async () => {
    let providerCalls = 0;
    __setSseBrokerProviderFactoryForTests(async () => {
      providerCalls++;
      throw new Error("still down");
    });

    const ok = await runSseBrokerWarmup([0, 0]);

    expect(ok).toBe(false);
    expect(providerCalls).toBe(2);
    // A failed init is not cached: the next (per-request) caller retries.
    __setSseBrokerProviderFactoryForTests(async () => ({}));
    expect(await getServerSseBrokerForWidget()).not.toBeNull();
  });
});

describe("test seams are guarded outside NODE_ENV=test (PR #1860 R1)", () => {
  test("both seams throw when NODE_ENV is not 'test'", () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => __resetServerSseBrokerForTests()).toThrow(/test-only/);
      expect(() => __setSseBrokerProviderFactoryForTests(null)).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
