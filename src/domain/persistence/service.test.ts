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
import { PersistenceService } from "./service";

const FAKE_CONNECTION_STRING = "postgresql://fake";
const DB_UNAVAILABLE = "DB unavailable";

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

  test("loadConfiguration via initialize() resolves postgres from legacy sessiondb.* (mt#1224 regression)", async () => {
    // Regression: the bootstrap used to read `config.persistence` only, so env vars
    // that populate `config.sessiondb.*` had no effect. After mt#1275, the bootstrap
    // uses getEffectivePersistenceConfig, so legacy shapes are honored.
    const { mock: mockFn } = await import("bun:test");
    // Use mock.module to replace `getConfiguration` — direct assignment fails in ESM.
    mockFn.module("../configuration", () => ({
      getConfiguration: () =>
        ({
          // note: no `persistence` override — defaults remain
          sessiondb: {
            backend: "postgres",
            postgres: { connectionString: FAKE_CONNECTION_STRING },
          },
        }) as any,
    }));

    const service = new PersistenceService();
    const { PersistenceProviderFactory } = await import("./factory");
    const origCreate = PersistenceProviderFactory.create;

    let capturedConfig: any = null;
    PersistenceProviderFactory.create = mock(async (config: any) => {
      capturedConfig = config;
      return {
        initialize: mock(() => Promise.resolve()),
        getStorage: mock(() => ({})),
        getCapabilities: mock(() => ({})),
        close: mock(() => Promise.resolve()),
      };
    }) as any;

    try {
      // Call initialize() with NO explicit config — forces loadConfiguration() path.
      await service.initialize();

      expect(capturedConfig).not.toBeNull();
      expect(capturedConfig.backend).toBe("postgres");
      expect(capturedConfig.postgres?.connectionString).toBe(FAKE_CONNECTION_STRING);
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
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
