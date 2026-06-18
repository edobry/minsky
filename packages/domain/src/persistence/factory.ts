/**
 * Persistence Provider Factory
 *
 * Creates appropriate persistence provider based on configuration.
 */

import { PersistenceProvider, PersistenceConfig } from "./types";
import { PostgresProviderFactory } from "./providers/postgres-provider-factory";
import { log } from "@minsky/shared/logger";

/**
 * Convenience helper for hooks and scripts that need a one-shot DB connection.
 *
 * Creates, initializes, and returns the configured PersistenceProvider without
 * requiring a full DI container setup. Used by `.claude/hooks/` files that need
 * DB access (e.g., to record subagent invocations) but run outside the MCP server
 * process.
 *
 * The caller is responsible for calling `provider.close()` when done.
 *
 * Returns `null` on any initialization error — callers should treat null as
 * "DB unavailable" and proceed without recording.
 */
export async function resolvePersistenceProvider(): Promise<PersistenceProvider | null> {
  try {
    const { PersistenceService } = await import("./service");
    const service = new PersistenceService();
    await service.initialize();
    return service.getProvider();
  } catch {
    return null;
  }
}

/**
 * Factory for creating persistence providers
 */
export class PersistenceProviderFactory {
  /**
   * Create a persistence provider based on configuration
   * Async to support runtime capability detection
   */
  static async create(config: PersistenceConfig): Promise<PersistenceProvider> {
    log.debug(`Creating persistence provider for backend: ${config.backend}`);

    let provider: PersistenceProvider;

    switch (config.backend) {
      case "postgres":
        if (!config.postgres) {
          throw new Error(
            "PostgreSQL configuration required for postgres backend: " +
              "persistence.backend='postgres' but persistence.postgres is undefined. " +
              "Set persistence.postgres.connectionString in config, or export " +
              "MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL) as an env var."
          );
        }
        if (!config.postgres.connectionString || !config.postgres.connectionString.trim()) {
          throw new Error(
            "PostgreSQL configuration incomplete: persistence.postgres.connectionString is empty or whitespace. " +
              "Set it in config or export MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL)."
          );
        }
        // Use factory to create appropriate PostgreSQL provider based on runtime capabilities
        provider = await PostgresProviderFactory.create(config);
        break;

      default:
        throw new Error(`Unsupported persistence backend: ${config.backend}`);
    }

    log.info(`Persistence provider created: ${provider.constructor.name}`);
    return provider;
  }

  /**
   * Create a mock provider for testing
   */
  static createMock(
    capabilities?: Partial<PersistenceProvider["capabilities"]>
  ): PersistenceProvider {
    return new MockPersistenceProvider(capabilities);
  }
}

/**
 * Mock persistence provider for testing
 */
class MockPersistenceProvider extends PersistenceProvider {
  readonly capabilities: {
    sql: boolean;
    transactions: boolean;
    jsonb: boolean;
    vectorStorage: boolean;
    migrations: boolean;
  };

  constructor(private customCapabilities?: Partial<PersistenceProvider["capabilities"]>) {
    super();
    this.capabilities = {
      sql: false,
      transactions: false,
      jsonb: false,
      vectorStorage: false,
      migrations: false,
      ...customCapabilities,
    };
  }

  getCapabilities() {
    return this.capabilities;
  }

  async initialize(): Promise<void> {
    // No-op for mock
  }

  async getVectorStorage() {
    return null;
  }

  async getDatabaseConnection() {
    return null;
  }

  async close(): Promise<void> {
    // No-op for mock
  }

  getConnectionInfo(): string {
    return "Mock Provider (testing)";
  }
}
