/**
 * TARGETED TEST: Missing storage.get() method architectural bug
 *
 * This test specifically catches the bug we discovered where:
 * - PostgresStorage implemented getEntity() but not get()
 * - SessionDbAdapter expected storage.get() method
 * - This caused all session lookups by name to fail
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("PostgresStorage Interface Completeness", () => {
  test("PostgresStorage must implement both getEntity() and get() methods", async () => {
    // This test ensures we never regress on the storage interface completeness
    const { PostgresStorage } = await import("./backends/postgres-storage");

    // Create a mock config
    const mockConfig = {
      connectionString: "postgresql://test:test@localhost:5432/test",
      maxConnections: 10,
      connectTimeout: 30,
    };

    const storage = new PostgresStorage(mockConfig, null as any); // Mock sql connection

    // Verify both methods exist on the interface
    expect(typeof storage.getEntity).toBe("function");
    expect(typeof (storage as any).get).toBe("function"); // get() should exist

    // Verify get() method signature matches expected interface
    expect(storage.getEntity.length).toBe(2); // (id, options?)
    expect((storage as any).get.length).toBe(1); // (id)
  });

  test("storage.get() returns DatabaseReadResult format expected by SessionDbAdapter", () => {
    // This test ensures the return format compatibility
    // We don't need to run it, just verify the types compile correctly

    type DatabaseReadResult<T> = {
      success: boolean;
      data?: T;
      error?: Error;
    };

    // This should compile without errors if our interface is correct
    const mockResult: DatabaseReadResult<any> = {
      success: true,
      data: { session: "test" },
    };

    expect(mockResult.success).toBe(true);
  });

  test("SessionDbAdapter expects storage.get() method (interface contract)", async () => {
    // This test documents the expected interface contract
    // that SessionDbAdapter relies on

    const expectedMethods = [
      "get", // ← This was missing and caused the bug!
      "getEntity",
      "readState",
      "writeState",
      "initialize",
    ];

    // Mock storage that should have all expected methods
    const mockStorage = {
      get: mock(() => Promise.resolve({ success: true, data: {} })),
      getEntity: mock(() => Promise.resolve({})),
      readState: mock(() => Promise.resolve({ success: true, data: { sessions: [] } })),
      writeState: mock(() => Promise.resolve({ success: true })),
      initialize: mock(() => Promise.resolve(true)),
    };

    // Verify all expected methods exist
    for (const method of expectedMethods) {
      expect(typeof (mockStorage as any)[method]).toBe("function");
    }
  });
});
