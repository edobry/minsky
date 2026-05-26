/**
 * Test for bug mt#722: PostgresStorage swallows connection errors as empty results
 *
 * Bug description:
 * - PostgresStorage.getEntity() catches all errors and returns null
 * - PostgresStorage.getEntities() catches all errors and returns []
 * - This makes connection failures look like "no data" instead of errors
 * - Session records appear to "vanish" when the Postgres connection drops
 *
 * Root cause:
 * - catch blocks in getEntity/getEntities swallow errors and return null/[]
 * - 10-second idle_timeout causes frequent connection drops in interactive use
 * - Reconnection failures are invisible to callers
 *
 * Expected behavior:
 * - Connection/query errors should propagate as thrown errors
 * - Only "not found" should return null (for getEntity) — not connection failures
 * - getEntities should throw on connection failure, not return empty array
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PostgresStorage } from "./postgres-storage";
import type { PersistenceProvider } from "../../persistence/types";

// Minimal mock provider that simulates a connection failure
function makeFailingProvider(): PersistenceProvider {
  return {
    capabilities: {
      sql: true,
      transactions: false,
      jsonb: false,
      vectorStorage: false,
      migrations: false,
    },
    getCapabilities: () => ({
      sql: true,
      transactions: false,
      jsonb: false,
      vectorStorage: false,
      migrations: false,
    }),
    getStorage: () => {
      throw new Error("not implemented");
    },
    initialize: async () => {},
    close: async () => {},
    getConnectionInfo: () => "mock-failing",
    getDatabaseConnection: async () => {
      throw new Error("simulated connection failure");
    },
    getRawSqlConnection: async () => {
      throw new Error("simulated connection failure");
    },
  } as unknown as PersistenceProvider;
}

// We test through the public API with a mock that simulates connection failures
describe("PostgresStorage error propagation (mt#722)", () => {
  let storage: PostgresStorage;

  beforeEach(() => {
    storage = new PostgresStorage(
      {
        connectionString: "postgresql://x:x@invalid:0/x",
        maxConnections: 1,
        connectTimeout: 1,
      },
      makeFailingProvider()
    );
  });

  describe("getEntity", () => {
    it("should throw on connection/query errors, not return null", async () => {
      // Bug: getEntity catches all errors and returns null
      // This makes connection failures look like "session not found"
      //
      // The storage is not initialized (no real DB), so any query should throw.
      // Before fix: returns null (error swallowed)
      // After fix: throws an error

      await expect(storage.getEntity("test-session-id")).rejects.toThrow();
    });
  });

  describe("getEntities", () => {
    it("should throw on connection/query errors, not return empty array", async () => {
      // Bug: getEntities catches all errors and returns []
      // This makes connection failures look like "no sessions exist"
      //
      // Before fix: returns [] (error swallowed)
      // After fix: throws an error

      await expect(storage.getEntities()).rejects.toThrow();
    });
  });
});
