/**
 * Unit tests for `createCachedSqlDbGetter` (mt#2615).
 *
 * Exercises the cache-negative vs. retry-on-failure behavior that was
 * previously duplicated (with a real difference per callsite) across
 * `getContextInspectorDb` (cacheNegative: true) and the db-probe halves of
 * `getServerAskRepository` / `getServerTaskDetailDeps` (cacheNegative: false)
 * in the pre-split server.ts. Uses the `getProvider` test seam so no real DB
 * or `shared-persistence` module mocking is needed.
 */
import { describe, test, expect } from "bun:test";
import { createCachedSqlDbGetter } from "./db-providers";

type FakeDb = { marker: string };

function makeFailingProvider() {
  return { getDatabaseConnection: undefined };
}

function makeSuccessProvider(db: FakeDb) {
  return { getDatabaseConnection: async () => db };
}

describe("createCachedSqlDbGetter", () => {
  test("cacheNegative: true — permanently caches null after the first failed probe", async () => {
    let calls = 0;
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return makeFailingProvider();
      },
    });

    expect(await getDb()).toBeNull();
    expect(await getDb()).toBeNull();
    expect(await getDb()).toBeNull();
    // Only the FIRST call actually probed — later calls short-circuit on the
    // permanently-cached null (matches getContextInspectorDb's exact
    // pre-split `_cachedContextInspectorDbProbed` behavior).
    expect(calls).toBe(1);
  });

  test("cacheNegative: false — retries the probe on every call until success", async () => {
    let calls = 0;
    const db: FakeDb = { marker: "the-db" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: false,
      getProvider: async () => {
        calls++;
        // Fail the first two probes, succeed on the third.
        if (calls < 3) return makeFailingProvider();
        return makeSuccessProvider(db);
      },
    });

    expect(await getDb()).toBeNull();
    expect(await getDb()).toBeNull();
    expect(await getDb()).toBe(db as unknown as never);
    // Every call before success re-probed (matches getServerAskRepository /
    // getServerTaskDetailDeps's exact pre-split behavior: only a SUCCESSFUL
    // result is cached; failures retry indefinitely).
    expect(calls).toBe(3);
  });

  test("cacheNegative: false — subsequent calls after success do NOT re-probe", async () => {
    let calls = 0;
    const db: FakeDb = { marker: "cached" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: false,
      getProvider: async () => {
        calls++;
        return makeSuccessProvider(db);
      },
    });

    await getDb();
    await getDb();
    await getDb();
    expect(calls).toBe(1);
  });

  test("cacheNegative: true — a successful probe caches the db and stops re-probing", async () => {
    let calls = 0;
    const db: FakeDb = { marker: "eventually-ok" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return makeSuccessProvider(db);
      },
    });

    expect(await getDb()).toBe(db as unknown as never);
    expect(await getDb()).toBe(db as unknown as never);
    expect(calls).toBe(1);
  });

  test("a thrown error from getProvider is treated as a failed probe", async () => {
    let calls = 0;
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        throw new Error("boom");
      },
    });

    expect(await getDb()).toBeNull();
    expect(await getDb()).toBeNull();
    expect(calls).toBe(1); // cacheNegative: true — permanently cached after the throw.
  });

  test("a provider lacking getDatabaseConnection is treated as unsupported (null)", async () => {
    const getDb = createCachedSqlDbGetter({
      cacheNegative: false,
      getProvider: async () => ({ someOtherCapability: true }),
    });

    expect(await getDb()).toBeNull();
  });
});
