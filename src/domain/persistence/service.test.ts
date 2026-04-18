/**
 * PersistenceService cache-before-init regression tests
 *
 * Verifies that after initialization failure:
 * - provider is null (not stale)
 * - isInitialized() returns false
 * - getProvider() throws
 * - retry re-attempts initialization
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PersistenceService } from "./service";

const FAKE_CONNECTION_STRING = "postgresql://fake";
const DB_UNAVAILABLE = "DB unavailable";

// Save original state so we can restore it
let originalProvider: unknown;

beforeEach(async () => {
  // Capture the current provider state
  originalProvider = (PersistenceService as unknown as { provider: unknown }).provider;
  // Reset to clean state
  await PersistenceService.reset();
});

afterEach(async () => {
  // Restore original state so we don't affect other tests
  await PersistenceService.reset();
  (PersistenceService as unknown as { provider: unknown }).provider = originalProvider;
});

describe("PersistenceService cache-before-init", () => {
  test("isInitialized() returns false after failed initialization", async () => {
    // Mock the factory to return a provider whose initialize() throws
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
        PersistenceService.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow(DB_UNAVAILABLE);

      expect(PersistenceService.isInitialized()).toBe(false);
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });

  test("getProvider() throws after failed initialization", async () => {
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
        PersistenceService.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow();

      expect(() => PersistenceService.getProvider()).toThrow("PersistenceService not initialized");
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });

  test("initialization can be retried after failure", async () => {
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
        PersistenceService.initialize({
          backend: "postgres",
          postgres: { connectionString: FAKE_CONNECTION_STRING },
        })
      ).rejects.toThrow();

      expect(PersistenceService.isInitialized()).toBe(false);

      // Second attempt succeeds
      await PersistenceService.initialize({
        backend: "postgres",
        postgres: { connectionString: FAKE_CONNECTION_STRING },
      });

      expect(PersistenceService.isInitialized()).toBe(true);
      expect(PersistenceService.getProvider()).toBeDefined();
    } finally {
      PersistenceProviderFactory.create = origCreate;
    }
  });
});
