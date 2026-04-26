/**
 * Persistence Provider Factory
 *
 * Creates appropriate persistence provider based on configuration.
 */

import { PersistenceProvider, PersistenceConfig, type SessionStorage } from "./types";
import type { SessionRecord } from "../session/types";
import type { SessionDbState } from "../session/session-db";
import { PostgresProviderFactory } from "./providers/postgres-provider-factory";
import { SqlitePersistenceProvider } from "./providers/sqlite-provider";
import { log } from "../../utils/logger";

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

      case "sqlite":
        if (!config.sqlite) {
          throw new Error("SQLite configuration required for sqlite backend");
        }
        provider = new SqlitePersistenceProvider(config);
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

  getStorage(): SessionStorage {
    const data = new Map<string, SessionRecord>();
    let state: SessionDbState = { sessions: [], baseDir: "" };
    const storage: SessionStorage = {
      readState: async () => ({ success: true, data: state }),
      writeState: async (newState: SessionDbState) => {
        state = newState;
        return { success: true };
      },
      getEntity: async (id: string) => data.get(id) ?? null,
      getEntities: async () => Array.from(data.values()),
      createEntity: async (entity: SessionRecord) => {
        const id = entity.session || String(data.size);
        data.set(id, entity);
        return entity;
      },
      updateEntity: async (id: string, updates: Partial<SessionRecord>) => {
        const existing = data.get(id);
        if (existing) {
          const updated = { ...existing, ...updates };
          data.set(id, updated);
          return updated;
        }
        return null;
      },
      deleteEntity: async (id: string) => {
        return data.delete(id);
      },
      entityExists: async (id: string) => data.has(id),
      initialize: async () => true,
      getStorageLocation: () => "mock-storage",
    };
    return storage;
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
