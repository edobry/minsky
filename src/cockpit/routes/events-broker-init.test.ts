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
