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
import type { Configuration } from "../configuration/schemas";

const FAKE_CONNECTION_STRING = "postgresql://fake";
const DB_UNAVAILABLE = "DB unavailable";
const SESSIONDB_CONN = "postgresql://from-sessiondb";

/**
 * Minimal Configuration shapes used to exercise the fallback resolution.
 * Casts to Configuration are unavoidable because the full schema requires
 * many unrelated keys we don't care about for these tests.
 */
const makeConfig = (parts: Partial<Configuration> & { sessiondb?: unknown }): Configuration =>
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

  describe("buildPersistenceConfigFrom (mt#1271 — runtime fallback)", () => {
    test("modern persistence.* path: returns postgres backend with connection string", () => {
      const config = makeConfig({
        persistence: {
          backend: "postgres",
          postgres: { connectionString: "postgresql://modern" },
          sqlite: { dbPath: "/never/used" },
        },
      });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("postgres");
      expect(out.postgres?.connectionString).toBe("postgresql://modern");
    });

    test("precedence: explicit persistence.backend wins over sessiondb.backend", () => {
      // Documented order in getEffectivePersistenceConfig: modern `persistence.*`
      // takes precedence over the legacy `sessiondb.*` shape. We verify this
      // specifically for the case where both are populated to disambiguate.
      const config = makeConfig({
        persistence: {
          backend: "sqlite",
          sqlite: { dbPath: "/default/sqlite.db" },
        },
        sessiondb: {
          backend: "postgres",
          postgres: { connectionString: SESSIONDB_CONN },
        },
      });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("sqlite");
    });

    test("hosted-deploy path: persistence undefined, sessiondb.* alone resolves to postgres", () => {
      // The exact hosted Railway scenario after mt#1271: container has
      // MINSKY_SESSIONDB_BACKEND=postgres + MINSKY_SESSIONDB_POSTGRES_URL set.
      // No `persistence.*` block in any committed config or env mapping.
      // (We omit `persistence` entirely here to simulate the absence of the
      // defaults-source contribution — see the follow-up note below.)
      const config = makeConfig({
        sessiondb: {
          backend: "postgres",
          postgres: { connectionString: SESSIONDB_CONN },
        },
      });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("postgres");
      expect(out.postgres?.connectionString).toBe(SESSIONDB_CONN);
    });

    test("postgres backend with no connection string anywhere: postgres entry omitted", () => {
      // Edge case: backend says postgres but no connection string set. Caller
      // (factory.create) will throw "PostgreSQL configuration required". We
      // verify we don't fabricate a postgres entry.
      const config = makeConfig({ sessiondb: { backend: "postgres" } });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("postgres");
      expect(out.postgres).toBeUndefined();
    });

    test("sqlite backend: returns sqlite entry with default or configured dbPath", () => {
      const config = makeConfig({
        persistence: {
          backend: "sqlite",
          sqlite: { dbPath: "/configured/path.db" },
        },
      });
      const out = buildPersistenceConfigFrom(config);
      expect(out.backend).toBe("sqlite");
      expect(out.sqlite?.dbPath).toBe("/configured/path.db");
    });

    test("MINSKY_POSTGRES_URL env var: bottom-of-stack fallback for connection string", () => {
      const prev = process.env.MINSKY_POSTGRES_URL;
      process.env.MINSKY_POSTGRES_URL = "postgresql://from-env";
      try {
        const config = makeConfig({ sessiondb: { backend: "postgres" } });
        const out = buildPersistenceConfigFrom(config);
        expect(out.backend).toBe("postgres");
        expect(out.postgres?.connectionString).toBe("postgresql://from-env");
      } finally {
        if (prev === undefined) delete process.env.MINSKY_POSTGRES_URL;
        else process.env.MINSKY_POSTGRES_URL = prev;
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
