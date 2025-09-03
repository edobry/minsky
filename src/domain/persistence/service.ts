/**
 * Persistence Service
 *
 * Singleton service for managing persistence provider lifecycle.
 * Combines factory and singleton patterns for production use and testing flexibility.
 */

import { PersistenceProvider, PersistenceConfig } from "./types";
import { PersistenceProviderFactory } from "./factory";
import { getConfiguration } from "../configuration";
import { log } from "../../utils/logger";

/**
 * Persistence service singleton
 */
export class PersistenceService {
  private static provider: PersistenceProvider | null = null;
  private static initPromise: Promise<void> | null = null;

  /**
   * Initialize the persistence service with configuration
   */
  static async initialize(config?: PersistenceConfig): Promise<void> {
    // Prevent concurrent initialization
    if (PersistenceService.initPromise) {
      return PersistenceService.initPromise;
    }

    PersistenceService.initPromise = PersistenceService.performInitialization(config);

    try {
      await PersistenceService.initPromise;
    } finally {
      PersistenceService.initPromise = null;
    }
  }

  /**
   * Perform actual initialization
   */
  private static async performInitialization(config?: PersistenceConfig): Promise<void> {
    try {
      // Use provided config or load from configuration
      const persistenceConfig = config || PersistenceService.loadConfiguration();

      // Create provider using factory
      PersistenceService.provider = PersistenceProviderFactory.create(persistenceConfig);

      // Initialize the provider
      await PersistenceService.provider.initialize();

      log.info("PersistenceService initialized successfully");
    } catch (error) {
      log.error("Failed to initialize PersistenceService:", error);
      throw error;
    }
  }

  /**
   * Load configuration from runtime config
   */
  private static loadConfiguration(): PersistenceConfig {
    const runtimeConfig = getConfiguration();

    // Check for new persistence config structure
    if (runtimeConfig.persistence) {
      return runtimeConfig.persistence;
    }

    // Fall back to legacy sessiondb config for backward compatibility
    if (
      runtimeConfig.sessiondb?.connectionString &&
      runtimeConfig.sessiondb.backend === "postgres"
    ) {
      log.warn(
        "Using legacy sessiondb configuration. Please migrate to persistence: configuration."
      );
      return {
        backend: "postgres",
        postgres: {
          connectionString: runtimeConfig.sessiondb.connectionString,
          maxConnections: 10,
          connectTimeout: 30000,
          idleTimeout: 10000,
          prepareStatements: true,
        },
      };
    }

    // SQLite fallback from sessiondb
    if (runtimeConfig.sessiondb?.backend === "sqlite") {
      log.warn(
        "Using legacy sessiondb configuration. Please migrate to persistence: configuration."
      );
      return {
        backend: "sqlite",
        sqlite: {
          dbPath: runtimeConfig.sessiondb.dbPath || "~/.local/state/minsky/minsky.db",
        },
      };
    }

    throw new Error(
      "No persistence configuration found. Please configure 'persistence:' in your configuration."
    );
  }

  /**
   * Get the persistence provider instance
   */
  static getProvider(): PersistenceProvider {
    if (!PersistenceService.provider) {
      throw new Error(
        "PersistenceService not initialized. Call PersistenceService.initialize() first."
      );
    }
    return PersistenceService.provider;
  }

  /**
   * Check if service is initialized
   */
  static isInitialized(): boolean {
    return PersistenceService.provider !== null;
  }

  /**
   * Close the persistence service
   */
  static async close(): Promise<void> {
    if (PersistenceService.provider) {
      await PersistenceService.provider.close();
      PersistenceService.provider = null;
    }
  }

  /**
   * Reset the service (alias for close, mainly for testing)
   */
  static async reset(): Promise<void> {
    return PersistenceService.close();
  }

  /**
   * Set a mock provider for testing
   */
  static setMockProvider(provider: PersistenceProvider): void {
    PersistenceService.provider = provider;
  }
}

/**
 * Convenience function to get persistence provider
 * Ensures service is initialized before returning provider
 */
export async function getPersistenceProvider(): Promise<PersistenceProvider> {
  if (!PersistenceService.isInitialized()) {
    await PersistenceService.initialize();
  }
  return PersistenceService.getProvider();
}
