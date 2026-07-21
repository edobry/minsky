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
import { createCachedSqlDbGetter, __resetDbProvidersForTests } from "./db-providers";

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

  // ---------------------------------------------------------------------
  // Test-only reset capability (mt#3016) — the general isolation-hygiene
  // fix named in-scope by the mt#3016 spec, mirroring shared-persistence.ts's
  // __resetSharedPersistenceForTests(). NOT the fix for the actual mt#3016
  // flake (that fix is DI seams in task-list.ts/agents.ts/routes/
  // conversation-search.ts/routes/conversations.ts — see those files'
  // docstrings) — this is a defense-in-depth capability for any future test
  // that needs a guaranteed-fresh probe of a specific getter.
  // ---------------------------------------------------------------------

  test("__resetForTests() clears a getter's cache so the next call re-probes", async () => {
    let calls = 0;
    const db: FakeDb = { marker: "reset-me" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return makeSuccessProvider(db);
      },
    });

    expect(await getDb()).toBe(db as unknown as never);
    expect(await getDb()).toBe(db as unknown as never);
    expect(calls).toBe(1); // cached, no re-probe yet

    getDb.__resetForTests();

    expect(await getDb()).toBe(db as unknown as never);
    expect(calls).toBe(2); // reset forced a fresh probe
  });

  test("__resetForTests() also clears a permanently-cached negative result", async () => {
    let calls = 0;
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return makeFailingProvider();
      },
    });

    expect(await getDb()).toBeNull();
    expect(calls).toBe(1);

    getDb.__resetForTests();

    expect(await getDb()).toBeNull();
    expect(calls).toBe(2); // reset forced a fresh probe of the (still-failing) provider
  });

  test("__resetDbProvidersForTests() resets every getter this factory has produced", async () => {
    let calls = 0;
    const db: FakeDb = { marker: "bulk-reset" };
    // createCachedSqlDbGetter registers every instance it produces into the
    // module-level registry __resetDbProvidersForTests() iterates — this
    // getter is picked up automatically, with no need to name it individually.
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return makeSuccessProvider(db);
      },
    });

    expect(await getDb()).toBe(db as unknown as never);
    expect(calls).toBe(1);

    __resetDbProvidersForTests();

    expect(await getDb()).toBe(db as unknown as never);
    expect(calls).toBe(2); // the bulk reset forced this getter to re-probe too
  });
});
