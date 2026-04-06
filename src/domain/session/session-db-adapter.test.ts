/**
 * Layer 2: Domain Layer Tests
 * Test that domain layer calls persistence layer correctly with mocked persistence services.
 * Uses dependency injection instead of mock.module().
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
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
          { session: "test-session-1", taskId: "mt#123", branch: "task/mt-123" },
          { session: "test-session-2", taskId: "mt#456", branch: "task/mt-456" },
        ],
        baseDir: "/test/path",
      },
    })
  ),
  writeState: mock(() => Promise.resolve({ success: true })),
  getEntities: mock(() =>
    Promise.resolve([
      { session: "test-session-1", taskId: "mt#123", branch: "task/mt-123" },
      { session: "test-session-2", taskId: "mt#456", branch: "task/mt-456" },
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
    expect(sessions[0]!.session).toBe("test-session-1");
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
});
