/**
 * Persistence Provider Factory
 *
 * Creates appropriate persistence provider based on configuration.
 */

import { PersistenceProvider, PersistenceConfig } from "./types";
import { PostgresPersistenceProvider } from "./providers/postgres-provider";
import { SqlitePersistenceProvider } from "./providers/sqlite-provider";
import { JsonPersistenceProvider } from "./providers/json-provider";
import { log } from "../../utils/logger";

/**
 * Factory for creating persistence providers
 */
export class PersistenceProviderFactory {
  /**
   * Create a persistence provider based on configuration
   */
  static async create(config: PersistenceConfig): Promise<PersistenceProvider> {
    log.debug(`Creating persistence provider for backend: ${config.backend}`);

    let provider: PersistenceProvider;

    switch (config.backend) {
      case 'postgres':
        if (!config.postgres) {
          throw new Error('PostgreSQL configuration required for postgres backend');
        }
        provider = new PostgresPersistenceProvider(config);
        break;

      case 'sqlite':
        if (!config.sqlite) {
          throw new Error('SQLite configuration required for sqlite backend');
        }
        provider = new SqlitePersistenceProvider(config);
        break;

      case 'json':
        if (!config.json) {
          throw new Error('JSON configuration required for json backend');
        }
        provider = new JsonPersistenceProvider(config);
        break;

      default:
        throw new Error(`Unsupported persistence backend: ${config.backend}`);
    }

    // Initialize the provider
    await provider.initialize();

    log.info(`Persistence provider initialized: ${provider.getConnectionInfo()}`);
    return provider;
  }

  /**
   * Create a mock provider for testing
   */
  static createMock(capabilities?: Partial<PersistenceProvider['capabilities']>): PersistenceProvider {
    return new MockPersistenceProvider(capabilities);
  }
}

/**
 * Mock persistence provider for testing
 */
class MockPersistenceProvider extends PersistenceProvider {
  readonly capabilities = {
    sql: false,
    transactions: false,
    jsonb: false,
    vectorStorage: false,
    migrations: false,
    ...this.customCapabilities,
  };

  constructor(private customCapabilities?: Partial<PersistenceProvider['capabilities']>) {
    super();
  }

  async initialize(): Promise<void> {
    // No-op for mock
  }

  getStorage<T, S>() {
    const storage: any = {
      data: new Map<string, T>(),
      get: async (id: string) => storage.data.get(id) || null,
      save: async (id: string, data: T) => { storage.data.set(id, data); },
      update: async (id: string, updates: Partial<T>) => {
        const existing = storage.data.get(id);
        if (existing) {
          storage.data.set(id, { ...existing, ...updates });
        }
      },
      delete: async (id: string) => { storage.data.delete(id); },
      search: async () => Array.from(storage.data.values()),
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
