/**
 * Persistence Service
 *
 * Injectable service for managing persistence provider lifecycle.
 * Created by the DI container in composition roots — domain code
 * receives it via constructor injection or typed deps interfaces.
 *
 * @see mt#814 — converted from static singleton to injectable instance
 */

import { injectable } from "tsyringe";
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
 * Persistence service — injectable instance.
 *
 * Manages the lifecycle of a PersistenceProvider (database connection).
 * Created once per application context (CLI, MCP, test) via the DI container.
 */
@injectable()
export class PersistenceService {
  private provider: PersistenceProvider | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the persistence service with configuration.
   * Safe to call multiple times — concurrent calls are coalesced.
   */
  async initialize(config?: PersistenceConfig): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.performInitialization(config);

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async performInitialization(config?: PersistenceConfig): Promise<void> {
    try {
      const persistenceConfig = config || PersistenceService.loadConfiguration();
      const provider = await PersistenceProviderFactory.create(persistenceConfig);
      await provider.initialize();
      this.provider = provider;
      log.info("PersistenceService initialized successfully");
    } catch (error) {
      this.provider = null;
      log.error(
        "Failed to initialize PersistenceService:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Load configuration from runtime config.
   * Static because it doesn't depend on instance state.
   */
  private static loadConfiguration(): PersistenceConfig {
    const runtimeConfig = getConfiguration();
    if (runtimeConfig.persistence) {
      return runtimeConfig.persistence;
    }
    throw new Error(
      "No persistence configuration found. Please configure 'persistence:' in your configuration."
    );
  }

  /**
   * Get the persistence provider instance.
   * Throws if not initialized.
   */
  getProvider(): PersistenceProvider {
    if (!this.provider) {
      throw new Error("PersistenceService not initialized. Call initialize() first.");
    }
    return this.provider;
  }

  /**
   * Get vector storage — type-safe approach using interface checking.
   */
  getVectorStorage(dimension: number): VectorStorage {
    const provider = this.getProvider();

    if (!this.isVectorCapable(provider)) {
      throw new CapabilityNotSupportedError("vectorStorage", provider.constructor.name);
    }

    return provider.getVectorStorage(dimension);
  }

  private isVectorCapable(
    provider: PersistenceProvider
  ): provider is VectorCapablePersistenceProvider {
    return (
      provider.capabilities.vectorStorage === true &&
      "getVectorStorage" in provider &&
      typeof provider.getVectorStorage === "function"
    );
  }

  /**
   * Check if service is initialized.
   */
  isInitialized(): boolean {
    return this.provider !== null;
  }

  /**
   * Close the persistence service and release resources.
   */
  async close(): Promise<void> {
    if (this.provider) {
      await this.provider.close();
      this.provider = null;
    }
  }
}

/**
 * Convenience function to get persistence provider from the default instance.
 * @deprecated Use container.get("persistence") instead.
 */
export function getPersistenceProvider(): PersistenceProvider {
  return defaultInstance.getProvider();
}

/**
 * Default instance — used during migration period while callers
 * transition to container-based injection. Will be removed in Phase E.
 */
export const defaultInstance = new PersistenceService();

/**
 * Resolve a PersistenceProvider: use the explicit one if provided,
 * otherwise fall back to the default instance lazily.
 *
 * Callers with DI container access should always pass the provider
 * explicitly. This helper exists as a transitional bridge for domain
 * code that hasn't been fully migrated to container-based DI yet.
 *
 * @deprecated Prefer receiving the provider via constructor injection or deps interface.
 */
export function resolveProvider(provider?: PersistenceProvider): PersistenceProvider {
  if (provider) return provider;
  return defaultInstance.getProvider();
}
