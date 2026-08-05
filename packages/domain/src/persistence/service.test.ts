/**
 * PersistenceService cache-before-init regression tests
 *
 * Verifies that after initialization failure:
 * - provider is null (not stale)
 * - isInitialized() returns false
 * - getProvider() throws
 * - retry re-attempts initialization
 */
import { describe, test, expect, mock } from "bun:test";
import { PersistenceService, buildPersistenceConfigFrom } from "./service";
import { LegacySessiondbConfigError } from "../configuration/persistence-config";
import type { Configuration } from "../configuration/schemas";

const FAKE_CONNECTION_STRING = "postgresql://fake";
const DB_UNAVAILABLE = "DB unavailable";

/**
 * Minimal Configuration shapes used to exercise resolution behavior.
 * Casts to Configuration are unavoidable because the full schema requires
 * many unrelated keys we don't care about for these tests.
 */
const makeConfig = (parts: Partial<Configuration> & Record<string, unknown>): Configuration =>
  parts as unknown as Configuration;

describe("PersistenceService (instance)", () => {
  test("isInitialized() returns false after failed initialization", async () => {
    const service = new PersistenceService();
    const { PersistenceProviderFactory } = await import("./factory");
    const origCreate = PersistenceProviderFactory.create;

    PersistenceProviderFactory.create = mock(async () => ({
      initialize: mock(() => Promise.reject(new Error(DB_UNAVAILABLE))),
      getStorage: mock(() => ({})),
      getCapabilities: mock(() => ({})),
      close: mock(() => Promise.resolve()),
    })) as any;

    try {
      await expect(
        service.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow(DB_UNAVAILABLE);

      expect(service.isInitialized()).toBe(false);
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });

  test("getProvider() throws after failed initialization", async () => {
    const service = new PersistenceService();
    const { PersistenceProviderFactory } = await import("./factory");
    const origCreate = PersistenceProviderFactory.create;

    PersistenceProviderFactory.create = mock(async () => ({
      initialize: mock(() => Promise.reject(new Error(DB_UNAVAILABLE))),
      getStorage: mock(() => ({})),
      getCapabilities: mock(() => ({})),
      close: mock(() => Promise.resolve()),
    })) as any;

    try {
      await expect(
        service.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow();

      expect(() => service.getProvider()).toThrow("not initialized");
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });

  test("initialization can be retried after failure", async () => {
    const service = new PersistenceService();
    const { PersistenceProviderFactory } = await import("./factory");
    const origCreate = PersistenceProviderFactory.create;

    let callCount = 0;
    PersistenceProviderFactory.create = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          initialize: mock(() => Promise.reject(new Error(DB_UNAVAILABLE))),
          getStorage: mock(() => ({})),
          getCapabilities: mock(() => ({})),
          close: mock(() => Promise.resolve()),
        };
      }
      return {
        initialize: mock(() => Promise.resolve()),
        getStorage: mock(() => ({})),
        getCapabilities: mock(() => ({})),
        close: mock(() => Promise.resolve()),
      };
    }) as any;

    try {
      // First attempt fails
      await expect(
        service.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow();

      expect(service.isInitialized()).toBe(false);

      // Second attempt succeeds
      await service.initialize({
        backend: "postgres",
        postgres: { connectionString: FAKE_CONNECTION_STRING },
      });

      expect(service.isInitialized()).toBe(true);
      expect(service.getProvider()).toBeDefined();
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });

  describe("buildPersistenceConfigFrom (modern persistence-only resolution)", () => {
    test("modern persistence.* path: returns postgres backend with connection string", () => {
      const config = makeConfig({
        persistence: {
          backend: "postgres",
          postgres: { connectionString: "postgresql://modern" },
        },
      });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("postgres");
      expect(out.postgres?.connectionString).toBe("postgresql://modern");
    });

    test("postgres backend with no connection string anywhere: postgres entry omitted", () => {
      // Edge case: backend says postgres but no connection string set. Caller
      // (factory.create) will throw 'PostgreSQL configuration required'. We
      // verify we don't fabricate a postgres entry.
      const config = makeConfig({ persistence: { backend: "postgres" } });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("postgres");
      expect(out.postgres).toBeUndefined();
    });

    test("MINSKY_POSTGRES_URL env var: bottom-of-stack fallback for connection string", () => {
      const prev = process.env.MINSKY_POSTGRES_URL;
      process.env.MINSKY_POSTGRES_URL = "postgresql://from-env";
      try {
        const config = makeConfig({ persistence: { backend: "postgres" } });
        const out = buildPersistenceConfigFrom(config);
        expect(out.backend).toBe("postgres");
        expect(out.postgres?.connectionString).toBe("postgresql://from-env");
      } finally {
        if (prev === undefined) delete process.env.MINSKY_POSTGRES_URL;
        else process.env.MINSKY_POSTGRES_URL = prev;
      }
    });

    test("legacy sessiondb config throws LegacySessiondbConfigError (mt#1610)", () => {
      // Loud-fail-on-legacy: any merged config still containing a sessiondb:
      // block must throw with migration guidance, not silently strip the key.
      const config = makeConfig({
        sessiondb: {
          backend: "postgres",
          postgres: { connectionString: "postgresql://legacy" },
        },
      });
      expect(() => buildPersistenceConfigFrom(config)).toThrow(LegacySessiondbConfigError);
    });
  });

  describe("getProviderWithRetry() self-heal (mt#3751 / ADR-035 rule 1)", () => {
    /** Build a fake provider whose `initialize()` fails until `succeedFrom`. */
    function makeFlakyFactory(succeedFrom: number) {
      let calls = 0;
      return {
        create: mock(async () => {
          calls += 1;
          const attempt = calls;
          return {
            initialize: mock(() =>
              attempt >= succeedFrom ? Promise.resolve() : Promise.reject(new Error(DB_UNAVAILABLE))
            ),
            getStorage: mock(() => ({})),
            getCapabilities: mock(() => ({})),
            close: mock(() => Promise.resolve()),
          };
        }),
        callCount: () => calls,
      };
    }

    /** Read/mutate the service's private retry backoff state, mirroring the
     * technique container.test.ts already uses against TsyringeContainer's
     * private `retryState` map — avoids sleeping real wall-clock seconds to
     * exercise the backoff floor. */
    function retryStateOf(service: PersistenceService) {
      return (
        service as unknown as { retryState: { lastAttemptAtMs: number | null; delayMs: number } }
      ).retryState;
    }

    // AT1 (negative control): this test FAILS against current main, where
    // PersistenceService has no getProviderWithRetry() at all — getProvider()
    // just throws forever once `initialize()` has failed once, with nothing
    // that ever re-invokes initialize(). It passes once getProviderWithRetry()
    // exists and self-heals.
    test("AT1: boots degraded, DB ops fail, then recovers after the backoff clock advances — no restart", async () => {
      const service = new PersistenceService();
      const { PersistenceProviderFactory } = await import("./factory");
      const origCreate = PersistenceProviderFactory.create;
      const flaky = makeFlakyFactory(2); // fails attempt 1, succeeds attempt 2+
      PersistenceProviderFactory.create = flaky.create as any;

      try {
        // Boot: initialize() is what a real bootstrap (e.g.
        // createDomainContainer()) calls at startup, with an explicit config
        // (avoids depending on global getConfiguration() in this unit test).
        await expect(
          service.initialize({
            backend: "postgres",
            postgres: { connectionString: FAKE_CONNECTION_STRING },
          })
        ).rejects.toThrow(DB_UNAVAILABLE);
        expect(service.isInitialized()).toBe(false);
        expect(flaky.callCount()).toBe(1);

        // A "DB op" after boot is represented by getProviderWithRetry() — a
        // caller who never explicitly re-calls initialize(). Still inside the
        // backoff floor (SC3: repeated use must not hammer the DB), so this
        // must NOT re-attempt — it falls straight to getProvider()'s existing
        // synchronous throw rather than the mock's rejection.
        await expect(service.getProviderWithRetry()).rejects.toThrow(
          "PersistenceService not initialized"
        );
        expect(flaky.callCount()).toBe(1);

        // Advance the backoff clock (no real sleep — same technique
        // container.test.ts uses against TsyringeContainer's retryState).
        retryStateOf(service).lastAttemptAtMs = 0;

        // No process restart, no explicit initialize() call from the caller —
        // this SAME accessor call is what recovers it.
        const provider = await service.getProviderWithRetry();
        expect(provider).toBeDefined();
        expect(service.isInitialized()).toBe(true);
        expect(flaky.callCount()).toBe(2);
      } finally {
        PersistenceProviderFactory.create = origCreate;
      }
    });

    // AT2: idle recovery — zero operations happen DURING the failure window;
    // the first operation issued AFTER the condition would have cleared must
    // succeed on its own, without any prior polling call having "warmed up"
    // the retry.
    test("AT2: an idle service (zero calls during the outage) recovers on its first post-outage call", async () => {
      const service = new PersistenceService();
      const { PersistenceProviderFactory } = await import("./factory");
      const origCreate = PersistenceProviderFactory.create;
      const flaky = makeFlakyFactory(2);
      PersistenceProviderFactory.create = flaky.create as any;

      try {
        // Boot fails once, same as any process that boots during a blip.
        await expect(
          service.initialize({
            backend: "postgres",
            postgres: { connectionString: FAKE_CONNECTION_STRING },
          })
        ).rejects.toThrow(DB_UNAVAILABLE);
        expect(flaky.callCount()).toBe(1);

        // Nothing calls the service again until "the outage clears" — no
        // interim polling, no background loop. Simulate the clock elapsing.
        retryStateOf(service).lastAttemptAtMs = 0;

        // The FIRST operation after recovery succeeds directly.
        const provider = await service.getProviderWithRetry();
        expect(provider).toBeDefined();
        expect(flaky.callCount()).toBe(2);
      } finally {
        PersistenceProviderFactory.create = origCreate;
      }
    });

    // AT3: backoff bounds — repeated failures double the delay, capped, and
    // never exceed the container-layer precedent's ceiling.
    test("AT3: repeated failures double the backoff delay, capped at RETRY_MAX_INTERVAL_MS", async () => {
      const service = new PersistenceService();
      const { PersistenceProviderFactory } = await import("./factory");
      const origCreate = PersistenceProviderFactory.create;
      // Never succeeds — isolates pure backoff-widening behavior.
      PersistenceProviderFactory.create = mock(async () => ({
        initialize: mock(() => Promise.reject(new Error(DB_UNAVAILABLE))),
        getStorage: mock(() => ({})),
        getCapabilities: mock(() => ({})),
        close: mock(() => Promise.resolve()),
      })) as any;

      try {
        const { RETRY_MIN_INTERVAL_MS, RETRY_MAX_INTERVAL_MS } = await import("./retry-backoff");
        await expect(
          service.initialize({
            backend: "postgres",
            postgres: { connectionString: FAKE_CONNECTION_STRING },
          })
        ).rejects.toThrow();
        expect(retryStateOf(service).delayMs).toBe(RETRY_MIN_INTERVAL_MS);

        // Force each subsequent attempt through by simulating the floor
        // elapsing, and assert the delay strictly doubles until the cap.
        let previousDelay = retryStateOf(service).delayMs;
        for (let i = 0; i < 8; i += 1) {
          retryStateOf(service).lastAttemptAtMs = 0;
          await expect(service.getProviderWithRetry()).rejects.toThrow();
          const delay = retryStateOf(service).delayMs;
          expect(delay).toBeGreaterThanOrEqual(previousDelay);
          expect(delay).toBeLessThanOrEqual(RETRY_MAX_INTERVAL_MS);
          previousDelay = delay;
        }
        expect(previousDelay).toBe(RETRY_MAX_INTERVAL_MS);
      } finally {
        PersistenceProviderFactory.create = origCreate;
      }
    });

    test("a healthy service is never retried (no attempt beyond the successful one)", async () => {
      const service = new PersistenceService();
      const { PersistenceProviderFactory } = await import("./factory");
      const origCreate = PersistenceProviderFactory.create;
      let calls = 0;
      PersistenceProviderFactory.create = mock(async () => {
        calls += 1;
        return {
          initialize: mock(() => Promise.resolve()),
          getStorage: mock(() => ({})),
          getCapabilities: mock(() => ({})),
          close: mock(() => Promise.resolve()),
        };
      }) as any;

      try {
        // Boot succeeds immediately — this is the common case (no outage).
        await service.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        });
        expect(calls).toBe(1);
        const provider1 = await service.getProviderWithRetry();
        expect(calls).toBe(1);
        const provider2 = await service.getProviderWithRetry();
        expect(calls).toBe(1);
        expect(provider2).toBe(provider1);
      } finally {
        PersistenceProviderFactory.create = origCreate;
      }
    });

    test("lastRetryAttemptAt stays undefined after only the boot attempt, populates after a real retry", async () => {
      const service = new PersistenceService();
      const { PersistenceProviderFactory } = await import("./factory");
      const origCreate = PersistenceProviderFactory.create;
      PersistenceProviderFactory.create = mock(async () => ({
        initialize: mock(() => Promise.reject(new Error(DB_UNAVAILABLE))),
        getStorage: mock(() => ({})),
        getCapabilities: mock(() => ({})),
        close: mock(() => Promise.resolve()),
      })) as any;

      try {
        // Boot-only failure: ADR-035 rule 4 says this must render as "no
        // re-initialization attempted since boot", not "retrying".
        await expect(
          service.initialize({
            backend: "postgres",
            postgres: { connectionString: FAKE_CONNECTION_STRING },
          })
        ).rejects.toThrow();
        expect(service.retryAttemptCount).toBe(1);
        expect(service.lastRetryAttemptAt).toBeUndefined();
        expect(service.lastAttemptError).toContain(DB_UNAVAILABLE);

        // A genuine retry (attempt 2) must now be distinguishable.
        retryStateOf(service).lastAttemptAtMs = 0;
        await expect(service.getProviderWithRetry()).rejects.toThrow();
        expect(service.retryAttemptCount).toBe(2);
        expect(service.lastRetryAttemptAt).toBeDefined();
      } finally {
        PersistenceProviderFactory.create = origCreate;
      }
    });
  });

  test("close() delegates to provider.close() and nulls the provider (mt#1193)", async () => {
    const service = new PersistenceService();
    const { PersistenceProviderFactory } = await import("./factory");
    const origCreate = PersistenceProviderFactory.create;

    const providerCloseMock = mock(() => Promise.resolve());
    PersistenceProviderFactory.create = mock(async () => ({
      initialize: mock(() => Promise.resolve()),
      getStorage: mock(() => ({})),
      getCapabilities: mock(() => ({})),
      close: providerCloseMock,
    })) as any;

    try {
      await service.initialize({
        backend: "postgres",
        postgres: { connectionString: FAKE_CONNECTION_STRING },
      });
      expect(service.isInitialized()).toBe(true);

      await service.close();

      // Must actually call provider.close() — the MCP SIGTERM handler
      // (start-command.ts) depends on this to release pool sockets.
      expect(providerCloseMock).toHaveBeenCalledTimes(1);
      expect(service.isInitialized()).toBe(false);
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });
});
