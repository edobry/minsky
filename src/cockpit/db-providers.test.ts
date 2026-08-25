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
import {
  createCachedSqlDbGetter,
  __resetDbProvidersForTests,
  shouldRefuseTestEnvironmentDb,
  TestEnvironmentDbAccessError,
  describeWidgetDegradedReason,
  classifyDriverConnectionError,
  describeFailedPersistenceInit,
} from "./db-providers";
import { PersistenceUnavailableError } from "@minsky/domain/persistence/unconfigured-provider";
import { PersistenceInitTimeoutError } from "./shared-persistence";

type FakeDb = { marker: string };

// These doubles carry `capabilities` as of mt#4543, because the resolver now asks the
// capability rather than only whether the method exists. The subject of every test below
// is the CACHING behaviour, not capability detection — the provider shape is scaffolding,
// and it was previously shaped to a check that could not distinguish a real provider from
// the unconfigured stand-in.
//
// (Wording note: the word that would naturally appear at the end of that sentence is one
// the Prevent-Placeholder-Tests CI check greps for at the start of a comment line, so a
// line wrap alone turns it into a build failure. Not worth a second round to rediscover.)
function makeFailingProvider() {
  return { capabilities: { sql: false }, getDatabaseConnection: undefined };
}

function makeSuccessProvider(db: FakeDb) {
  return { capabilities: { sql: true }, getDatabaseConnection: async () => db };
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

// -------------------------------------------------------------------------
// Test-process live-database guard (mt#3254).
//
// Under `bun test`, module state and configuration are shared across every
// file in one process, so once ANY test calls initializeConfiguration() the
// PRODUCTION provider path resolves the real configured database — prod
// Supabase in this repo. That is not hypothetical: it wrote 29 fixture rows
// into prod `driven_sessions` and 2 into `driven_session_cost` across four
// test runs on 2026-07-22/23/24.
//
// mt#3016 addressed the same root by threading `getDb` DI seams through four
// individual consumers; the driven-session path was not one of them and
// leaked anyway. The guard therefore lives at the shared choke point, so a
// consumer added tomorrow is covered without remembering anything.
//
// The discriminator is PRODUCTION RESOLUTION — a getter built WITHOUT the
// `getProvider` seam. A getter given an explicit provider is receiving a
// deliberately-injected fake and is left alone; that is what every test
// above does, and none of them change.
// -------------------------------------------------------------------------

describe("test-process live-database guard (mt#3254)", () => {
  describe("shouldRefuseTestEnvironmentDb", () => {
    test("refuses production resolution under NODE_ENV=test with no opt-in", () => {
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: true,
          nodeEnv: "test",
          optIn: undefined,
        })
      ).toBe(true);
    });

    test("allows a seam-injected provider even under NODE_ENV=test", () => {
      // This is the case every other test in this file exercises. If this
      // ever flips to `true`, the guard has become a blanket "no db in
      // tests" rule and will break deliberate fake injection.
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: false,
          nodeEnv: "test",
          optIn: undefined,
        })
      ).toBe(false);
    });

    test("allows production resolution outside a test process", () => {
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: true,
          nodeEnv: "production",
          optIn: undefined,
        })
      ).toBe(false);
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: true,
          nodeEnv: undefined,
          optIn: undefined,
        })
      ).toBe(false);
    });

    test("allows production resolution under an explicit opt-in", () => {
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: true,
          nodeEnv: "test",
          optIn: "1",
        })
      ).toBe(false);
    });

    test("an empty opt-in value is NOT an opt-in", () => {
      // `MINSKY_ALLOW_TEST_DB=` in a shell exports an empty string. Treating
      // that as consent would let a stray unset-looking export disable the
      // guard silently.
      expect(
        shouldRefuseTestEnvironmentDb({
          isProductionResolution: true,
          nodeEnv: "test",
          optIn: "",
        })
      ).toBe(true);
    });
  });

  describe("wiring into createCachedSqlDbGetter", () => {
    // No test-only seam is needed to exercise these: the guard decides from
    // the resolution SHAPE and the environment, so a getter built with no
    // `getProvider` throws before it ever reaches a provider.

    test("a production-resolution getter in a test process THROWS", async () => {
      const getDb = createCachedSqlDbGetter({ cacheNegative: false });

      await expect(getDb()).rejects.toBeInstanceOf(TestEnvironmentDbAccessError);
    });

    test("it throws BEFORE any provider or connection work is attempted (PR #2342 R1)", async () => {
      // The reviewer's point: connecting is itself the hazard, because the
      // real provider may run connect-time side effects. Reaching the
      // provider at all would fail this test.
      let providerWasCalled = false;
      const getDb = createCachedSqlDbGetter({ cacheNegative: false });

      // Sanity-check the inverse in the same breath: an explicitly injected
      // provider IS reached, so this assertion can actually fail.
      const seamed = createCachedSqlDbGetter({
        cacheNegative: false,
        getProvider: async () => {
          providerWasCalled = true;
          return { getDatabaseConnection: async () => ({ marker: "fake" }) };
        },
      });

      await expect(getDb()).rejects.toBeInstanceOf(TestEnvironmentDbAccessError);
      expect(providerWasCalled).toBe(false);

      await seamed();
      expect(providerWasCalled).toBe(true);
    });

    test("a null-returning or throwing provider cannot downgrade the guard into silence", async () => {
      // Keying off the resolution shape rather than the resolved value means
      // there is no provider outcome — null, throw, partial connect — that
      // routes the guard into the "probe failed -> null" path.
      const getDb = createCachedSqlDbGetter({ cacheNegative: true });

      await expect(getDb()).rejects.toBeInstanceOf(TestEnvironmentDbAccessError);
      // Still throws on the second call: no negative result was cached.
      await expect(getDb()).rejects.toBeInstanceOf(TestEnvironmentDbAccessError);
    });

    test("the error names the opt-in variable so the fix is discoverable from the message", async () => {
      const getDb = createCachedSqlDbGetter({ cacheNegative: false });

      await expect(getDb()).rejects.toThrow(/MINSKY_ALLOW_TEST_DB/);
    });
  });
});

describe("epoch-keyed cache invalidation (mt#3638)", () => {
  test("a getter re-resolves after the persistence epoch moves", async () => {
    let epoch = 0;
    let resolves = 0;
    const dbA: FakeDb = { marker: "A" };
    const dbB: FakeDb = { marker: "B" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: false,
      getProvider: async () => {
        resolves++;
        return makeSuccessProvider(resolves === 1 ? dbA : dbB);
      },
      getEpoch: () => epoch,
    });

    expect(await getDb()).toBe(dbA as unknown as Awaited<ReturnType<typeof getDb>>);
    expect(await getDb()).toBe(dbA as unknown as Awaited<ReturnType<typeof getDb>>);
    expect(resolves).toBe(1);

    // Simulated pool recycle: the epoch moves, the cached handle is stale.
    epoch++;
    expect(await getDb()).toBe(dbB as unknown as Awaited<ReturnType<typeof getDb>>);
    expect(resolves).toBe(2);
  });

  test("an epoch bump clears a cached negative even under cacheNegative: true", async () => {
    let epoch = 0;
    let calls = 0;
    const db: FakeDb = { marker: "recovered" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: true,
      getProvider: async () => {
        calls++;
        return calls === 1 ? makeFailingProvider() : makeSuccessProvider(db);
      },
      getEpoch: () => epoch,
    });

    expect(await getDb()).toBeNull();
    expect(await getDb()).toBeNull();
    expect(calls).toBe(1); // permanently cached negative WITHIN the epoch

    // A recycle may have fixed exactly what made the probe fail — retry.
    epoch++;
    expect(await getDb()).toBe(db as unknown as Awaited<ReturnType<typeof getDb>>);
    expect(calls).toBe(2);
  });

  test("a stable epoch keeps the cache (no spurious re-resolution)", async () => {
    let resolves = 0;
    const db: FakeDb = { marker: "stable" };
    const getDb = createCachedSqlDbGetter({
      cacheNegative: false,
      getProvider: async () => {
        resolves++;
        return makeSuccessProvider(db);
      },
      getEpoch: () => 7,
    });

    await getDb();
    await getDb();
    await getDb();
    expect(resolves).toBe(1);
  });
});

// -------------------------------------------------------------------------
// describeWidgetDegradedReason (mt#3825) — three-state classification.
//
// Originating incident: `session_list error: write CONNECT_TIMEOUT
// undefined:undefined`, a raw postgres.js driver artifact rendered verbatim
// to the operator. Uses the `getDbStatus` test seam to drive AT2's three
// states without standing up three live database conditions.
// -------------------------------------------------------------------------

describe("describeWidgetDegradedReason (mt#3825)", () => {
  const NO_ARTIFACT = [/CONNECT_TIMEOUT/, /undefined:undefined/] as const;

  function driverConnectTimeout(): Error {
    return Object.assign(new Error("write CONNECT_TIMEOUT undefined:undefined"), {
      code: "CONNECT_TIMEOUT",
    });
  }

  test("AT2 — not-configured / configured-but-failed-at-boot (AT1) / driver-failure-on-initialized-provider render distinct, cause-carrying, artifact-free messages", () => {
    const notConfigured = describeWidgetDegradedReason(
      "session_list",
      new PersistenceUnavailableError("Persistence is not configured: no connection string."),
      { getDbStatus: () => "unreachable" }
    );
    const configuredButFailingAtBoot = describeWidgetDegradedReason(
      "session_list",
      driverConnectTimeout(),
      { getDbStatus: () => "degraded" }
    );
    const driverFailureOnInitializedProvider = describeWidgetDegradedReason(
      "session_list",
      driverConnectTimeout(),
      { getDbStatus: () => "ok" }
    );

    expect(notConfigured).toContain("not configured");
    expect(configuredButFailingAtBoot).toContain("Postgres IS configured");
    expect(driverFailureOnInitializedProvider).toContain("already established");

    const all = [notConfigured, configuredButFailingAtBoot, driverFailureOnInitializedProvider];
    for (const msg of all) {
      expect(msg).toContain("session_list:");
      for (const artifact of NO_ARTIFACT) expect(msg).not.toMatch(artifact);
    }
    expect(new Set(all).size).toBe(3);
  });

  test("a PersistenceInitTimeoutError classifies as configured-but-failed-at-boot", () => {
    const err = new PersistenceInitTimeoutError(30_000);
    const reason = describeWidgetDegradedReason("task_list", err, {
      getDbStatus: () => "degraded",
    });
    expect(reason).toContain("Postgres IS configured");
  });

  test("an unrecognized error passes through unclassified rather than mis-described as a DB problem", () => {
    const err = new Error("some unrelated bug");
    const reason = describeWidgetDegradedReason("workstreams", err, { getDbStatus: () => "ok" });
    expect(reason).toBe("workstreams: some unrelated bug");
  });

  test("classifyDriverConnectionError never re-embeds the raw driver artifact", () => {
    const phrase = classifyDriverConnectionError(driverConnectTimeout());
    expect(phrase).toBeDefined();
    for (const artifact of NO_ARTIFACT) expect(phrase).not.toMatch(artifact);
  });

  // Negative control (mt#3244): fails if describeFailedPersistenceInit
  // regresses to interpolating err.message directly — see PR body's
  // "Negative control:" line for the observed failing run against the
  // reverted pre-fix version.
  test("describeFailedPersistenceInit sanitizes the raw driver artifact (negative control)", () => {
    const rendered = describeFailedPersistenceInit(driverConnectTimeout());
    for (const artifact of NO_ARTIFACT) expect(rendered).not.toMatch(artifact);
  });

  // SC4 (recovery) — verified, not built. Every widget under
  // src/cockpit/widgets/ shares one catch-block contract: `try { ...; return
  // { state: "ok", payload }; } catch (err) { return { state: "degraded",
  // reason: describeWidgetDegradedReason(name, err) }; }`. Nothing in that
  // contract, or in describeWidgetDegradedReason itself, caches a failure
  // across calls — so a widget's NEXT poll clearing is a property of the
  // shape itself, not a mechanism this task builds. `fetchLikeAWidget` below
  // is that exact shape, parameterized on the operation the real widgets
  // vary (getSharedPersistenceService / getServerSessionProvider / etc.) via
  // the injected `op`, plus the same `getDbStatus` seam the three-state test
  // above uses. This reproduces the originating incident end to end: degraded
  // on a driver-level connect failure, then OK on the very next poll once the
  // underlying operation stops throwing — with no new retry/cache code added
  // anywhere in this PR to make that transition happen.
  test("a degraded widget's next poll returns to ok once the underlying operation stops throwing (SC4)", async () => {
    let shouldFail = true;
    const op = async () => {
      if (shouldFail) throw driverConnectTimeout();
      return { agents: [] };
    };
    async function fetchLikeAWidget(): Promise<{ state: "ok" | "degraded"; reason?: string }> {
      try {
        const payload = await op();
        return { state: "ok", payload } as { state: "ok"; payload: typeof payload };
      } catch (err) {
        return {
          state: "degraded",
          reason: describeWidgetDegradedReason("session_list", err, { getDbStatus: () => "ok" }),
        };
      }
    }

    const degraded = await fetchLikeAWidget();
    expect(degraded.state).toBe("degraded");
    expect(degraded.reason).toContain("session_list:");
    for (const artifact of NO_ARTIFACT) expect(degraded.reason).not.toMatch(artifact);

    // The underlying condition clears (network restored, DB reachable again)
    // — no reload, no additional cockpit-level cache to invalidate.
    shouldFail = false;
    const recovered = await fetchLikeAWidget();
    expect(recovered.state).toBe("ok");
    expect(recovered.reason).toBeUndefined();
  });
});
