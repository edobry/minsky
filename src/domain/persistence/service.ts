/**
 * Persistence Service
 *
 * Singleton service for managing persistence provider lifecycle.
 * Combines factory and singleton patterns for production use and testing flexibility.
 */

import {
  PersistenceProvider,
  VectorCapablePersistenceProvider,
  PersistenceConfig,
  CapabilityNotSupportedError,
} from "./types";
import { PersistenceProviderFactory } from "./factory";
import { getConfiguration } from "../configuration";
import { log } from "../../utils/logger";
import type { VectorStorage } from "../storage/vector/types";

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

      // Create provider using factory (now async for runtime capability detection)
      PersistenceService.provider = await PersistenceProviderFactory.create(persistenceConfig);

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

    // Check for persistence config structure
    if (runtimeConfig.persistence) {
      return runtimeConfig.persistence;
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
   * Get vector storage directly - type-safe approach using interface checking
   * This eliminates runtime capability checking by using TypeScript type guards
   */
  static getVectorStorage(dimension: number): VectorStorage {
    const provider = PersistenceService.getProvider();

    // Type guard: check if provider implements VectorCapablePersistenceProvider
    if (!PersistenceService.isVectorCapable(provider)) {
      throw new CapabilityNotSupportedError("vectorStorage", provider.constructor.name);
    }

    // TypeScript now knows provider has getVectorStorage method
    return provider.getVectorStorage(dimension);
  }

  /**
   * Type guard to check if provider supports vector storage
   */
  private static isVectorCapable(
    provider: PersistenceProvider
  ): provider is VectorCapablePersistenceProvider {
    return (
      provider.capabilities.vectorStorage === true &&
      "getVectorStorage" in provider &&
      typeof provider.getVectorStorage === "function"
    );
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
 * Assumes service is already initialized at application startup
 */
export function getPersistenceProvider(): PersistenceProvider {
  return PersistenceService.getProvider();
}
