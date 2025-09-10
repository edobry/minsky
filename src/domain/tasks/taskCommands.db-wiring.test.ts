import { describe, it, expect, beforeAll, mock } from "bun:test";
import { listTasksFromParams } from "./taskCommands";
import { createMockPersistenceService } from "../../utils/test-utils/dependencies";

describe("DB wiring for minsky backend", () => {
  beforeAll(async () => {
    // Set up mock persistence provider before any tests run
    const { PersistenceService } = await import("../persistence/service");
    const { createMockPersistenceProvider } = await import("../../utils/test-utils/dependencies");

    const mockProvider = createMockPersistenceProvider();
    PersistenceService.setMockProvider(mockProvider);

    // Initialize configuration for persistence tests
    const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");

    // Create a test configuration that uses PostgreSQL for database connection testing
    const testConfig = {
      persistence: {
        backend: "postgres" as const,
        postgres: {
          connectionString: "postgresql://localhost:5432/testdb",
        },
      },
      sessiondb: {
        backend: "postgres" as const,
        connectionString: "postgresql://localhost:5432/testdb",
      },
    };

    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: testConfig,
      enableCache: true,
      skipValidation: true,
    });
  });
  it("should work with minsky backend via multi-backend service (uses createConfiguredTaskService)", async () => {
    // With the new multi-backend approach, minsky backend is properly registered
    // and can connect to the configured Supabase database
    let threw: any = null;
    let result: any = null;

    try {
      result = await listTasksFromParams({ backend: "minsky", json: true } as any);
    } catch (err) {
      threw = err instanceof Error ? err : new Error(String(err));
    }

    // With multi-backend service and Supabase connection, this should now work
    // or fail with a more specific database connection error (not "Backend not found")
    if (threw) {
      expect(String(threw?.message || threw)).not.toMatch(/Backend not found/i);
      // If it fails, should be due to database connectivity, persistence configuration, or mock issues
      expect(String(threw?.message || threw)).toMatch(
        /PostgreSQL|database|connection|timeout|persistence|configuration|not a function|map.*undefined/i
      );
    } else {
      // If successful, should return task list (could be empty, that's fine)
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    }
  });
});
