/**
 * Layer 2: Domain Layer Tests
 * Test that domain layer calls persistence layer correctly with mocked persistence services.
 * Uses dependency injection instead of mock.module().
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { first } from "../../utils/array-safety";
import {
  createSessionProvider,
  SessionDbAdapter,
  type CreateSessionProviderDeps,
} from "./session-db-adapter";
import type { PersistenceProvider } from "../persistence/types";
import type { SessionRecord } from "./types";

const mockStorage = {
  initialize: mock(() => Promise.resolve()),
  readState: mock(() =>
    Promise.resolve({
      success: true,
      data: {
        sessions: [
          { sessionId: "test-session-1", taskId: "mt#123", branch: "task/mt-123" },
          { sessionId: "test-session-2", taskId: "mt#456", branch: "task/mt-456" },
        ],
        baseDir: "/test/path",
      },
    })
  ),
  writeState: mock(() => Promise.resolve({ success: true })),
  getEntities: mock(() =>
    Promise.resolve([
      { sessionId: "test-session-1", taskId: "mt#123", branch: "task/mt-123" },
      { sessionId: "test-session-2", taskId: "mt#456", branch: "task/mt-456" },
    ] as SessionRecord[])
  ),
};

const mockPersistenceProvider = {
  initialize: mock(() => Promise.resolve()),
  getStorage: mock(() => mockStorage),
  getRawSqlConnection: mock(() => Promise.resolve({})),
  getCapabilities: mock(() => ({
    supportsTransactions: true,
    supportsVectorStorage: true,
    supportsFullTextSearch: true,
  })),
  isInitialized: true,
} as unknown as PersistenceProvider;

const mockPersistenceService = {
  isInitialized: mock(() => true),
  getProvider: mock(() => mockPersistenceProvider),
};

const testDeps: CreateSessionProviderDeps = {
  persistenceService: mockPersistenceService,
};

describe("createSessionProvider", () => {
  beforeEach(async () => {
    // Reset mock call counts
    mockPersistenceService.isInitialized.mockClear();
    mockPersistenceService.getProvider.mockClear();
    mockStorage.readState.mockClear();
    mockStorage.getEntities.mockClear();

    // Initialize configuration for testing
    try {
      const { initializeConfiguration, CustomConfigFactory } = await import("../configuration");
      await initializeConfiguration(new CustomConfigFactory());
    } catch (error) {
      // Configuration might already be initialized, that's OK
    }
  });

  test("properly initializes PersistenceService", async () => {
    const provider = await createSessionProvider(undefined, testDeps);

    // Verify we get a valid provider (structure test)
    expect(provider).toBeDefined();
    expect(provider.listSessions).toBeDefined();
    expect(provider.getSessionByTaskId).toBeDefined();
  });

  test("returns SessionProvider instance", async () => {
    const provider = await createSessionProvider(undefined, testDeps);

    // createSessionProvider returns SessionAutoRepairProvider wrapping SessionDbAdapter
    expect(provider.listSessions).toBeDefined();
    expect(provider.getSession).toBeDefined();
    expect(provider.getSessionByTaskId).toBeDefined();
    // Check it has the auto-repair wrapper
    expect(provider.constructor.name).toBe("SessionAutoRepairProvider");
  });

  test("SessionDbAdapter.listSessions() calls storage correctly", async () => {
    const provider = await createSessionProvider(undefined, testDeps);

    const sessions = await provider.listSessions();

    // Verify it calls the persistence layer
    expect(mockStorage.readState).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(2);
    expect(first(sessions).sessionId).toBe("test-session-1");
  });

  test("SessionDbAdapter.getSessionByTaskId() filters correctly", async () => {
    const provider = await createSessionProvider(undefined, testDeps);

    const session = await provider.getSessionByTaskId("mt#123");

    // Should call readState to get all sessions
    expect(mockStorage.readState).toHaveBeenCalledTimes(1);
    expect(session).toBeDefined();
    expect(session?.taskId).toBe("mt#123");
  });

  test("SessionDbAdapter.getSessionByTaskId() returns null for non-existent task", async () => {
    const provider = await createSessionProvider(undefined, testDeps);

    const session = await provider.getSessionByTaskId("mt#999");

    expect(mockStorage.readState).toHaveBeenCalledTimes(1);
    expect(session).toBeNull();
  });
});

describe("SessionDbAdapter", () => {
  let adapter: SessionDbAdapter;

  beforeEach(async () => {
    // Clear all mock call counts
    mockStorage.readState.mockClear();
    mockStorage.initialize.mockClear();
    (mockPersistenceProvider.getStorage as unknown as { mockClear: () => void }).mockClear();

    adapter = new SessionDbAdapter(mockPersistenceProvider);
  });

  test("getStorage() initializes storage correctly", async () => {
    await (adapter as unknown as { getStorage: () => Promise<unknown> }).getStorage();

    expect(mockPersistenceProvider.getStorage).toHaveBeenCalledTimes(1);
    expect(mockStorage.initialize).toHaveBeenCalledTimes(1);
  });

  test("getStorage() does not cache storage when initialize() fails", async () => {
    // Make initialize fail on first call, succeed on second
    const failingStorage = {
      ...mockStorage,
      initialize: mock()
        .mockImplementationOnce(() => Promise.reject(new Error("init failed")))
        .mockImplementationOnce(() => Promise.resolve()),
      readState: mockStorage.readState,
    };
    const failingProvider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => failingStorage),
    } as unknown as PersistenceProvider;

    const failAdapter = new SessionDbAdapter(failingProvider);
    const getStorage = (failAdapter as unknown as { getStorage: () => Promise<unknown> })
      .getStorage;

    // First call should throw
    await expect(getStorage.call(failAdapter)).rejects.toThrow("init failed");

    // Second call should re-attempt initialization (not return stale cache)
    const storage = await getStorage.call(failAdapter);
    expect(storage).toBeDefined();
    expect(failingStorage.initialize).toHaveBeenCalledTimes(2);
    expect(failingProvider.getStorage).toHaveBeenCalledTimes(2);
  });

  test("getSession() propagates storage errors instead of returning null", async () => {
    const errorStorage = {
      ...mockStorage,
      initialize: mock(() => Promise.resolve()),
      getEntity: mock(() => Promise.reject(new Error("connection lost"))),
    };
    const errorProvider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => errorStorage),
    } as unknown as PersistenceProvider;

    const errorAdapter = new SessionDbAdapter(errorProvider);
    await expect(errorAdapter.getSession("test")).rejects.toThrow("connection lost");
  });

  test("listSessions() propagates storage errors instead of returning []", async () => {
    const errorStorage = {
      ...mockStorage,
      initialize: mock(() => Promise.resolve()),
      readState: mock(() => Promise.resolve({ success: false, error: new Error("DB down") })),
    };
    const errorProvider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => errorStorage),
    } as unknown as PersistenceProvider;

    const errorAdapter = new SessionDbAdapter(errorProvider);
    await expect(errorAdapter.listSessions()).rejects.toThrow("Failed to read session state");
  });

  test("doesSessionExist() propagates storage errors instead of returning false", async () => {
    const errorStorage = {
      ...mockStorage,
      initialize: mock(() => Promise.resolve()),
      entityExists: mock(() => Promise.reject(new Error("timeout"))),
    };
    const errorProvider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => errorStorage),
    } as unknown as PersistenceProvider;

    const errorAdapter = new SessionDbAdapter(errorProvider);
    await expect(errorAdapter.doesSessionExist("test")).rejects.toThrow("timeout");
  });

  test("getStorage() caches storage after successful initialization", async () => {
    const getStorage = (adapter as unknown as { getStorage: () => Promise<unknown> }).getStorage;

    // Call twice
    await getStorage.call(adapter);
    await getStorage.call(adapter);

    // getStorage on provider should only be called once (cached after first success)
    expect(mockPersistenceProvider.getStorage).toHaveBeenCalledTimes(1);
    expect(mockStorage.initialize).toHaveBeenCalledTimes(1);
  });
});

describe("SessionDbAdapter.listSessions(options) — pagination push-down (mt#933)", () => {
  test("with options, routes through storage.getEntities and skips readState", async () => {
    const records: SessionRecord[] = [
      { sessionId: "s1", taskId: "1" } as SessionRecord,
      { sessionId: "s2", taskId: "2" } as SessionRecord,
    ];
    const getEntitiesMock = mock((opts: unknown) => Promise.resolve(records));
    const readStateMock = mock(() =>
      Promise.resolve({ success: true, data: { sessions: [], baseDir: "/x" } })
    );
    const storage = {
      initialize: mock(() => Promise.resolve()),
      getEntities: getEntitiesMock,
      readState: readStateMock,
    };
    const provider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => storage),
    } as unknown as PersistenceProvider;

    const adapter = new SessionDbAdapter(provider);
    const opts = {
      taskId: "mt#933",
      limit: 5,
      offset: 10,
      orderBy: [{ field: "lastActivityAt", direction: "desc" as const }],
    };
    const out = await adapter.listSessions(opts);

    expect(out).toEqual(records);
    expect(getEntitiesMock).toHaveBeenCalledTimes(1);
    expect(getEntitiesMock).toHaveBeenCalledWith(opts);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  test("without options, retains backwards-compatible readState path", async () => {
    const readStateMock = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          sessions: [{ sessionId: "legacy", taskId: "1" } as SessionRecord],
          baseDir: "/x",
        },
      })
    );
    const getEntitiesMock = mock(() => Promise.resolve([]));
    const storage = {
      initialize: mock(() => Promise.resolve()),
      getEntities: getEntitiesMock,
      readState: readStateMock,
    };
    const provider = {
      ...mockPersistenceProvider,
      getStorage: mock(() => storage),
    } as unknown as PersistenceProvider;

    const adapter = new SessionDbAdapter(provider);
    const out = await adapter.listSessions();

    expect(out).toHaveLength(1);
    expect(readStateMock).toHaveBeenCalledTimes(1);
    expect(getEntitiesMock).not.toHaveBeenCalled();
  });
});
