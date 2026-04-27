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
import { getEffectivePersistenceConfig } from "../configuration/persistence-config";
import type { Configuration } from "../configuration/schemas";
import { log } from "../../utils/logger";
import type { VectorStorage } from "../storage/vector/types";

/**
 * Build a PersistenceConfig from a Configuration via the documented fallback
 * chain (`persistence.*` → `sessiondb.*` → MINSKY_POSTGRES_URL → defaults).
 *
 * Exported for test coverage of the legacy fallback path. Production code
 * goes through `PersistenceService.loadConfiguration` which calls this with
 * `getConfiguration()`. Lifting it to a pure function makes the env-var-only
 * hosted-deploy path (mt#1271) directly unit-testable without mocking the
 * global configuration provider.
 */
export function buildPersistenceConfigFrom(runtimeConfig: Configuration): PersistenceConfig {
  const effective = getEffectivePersistenceConfig(runtimeConfig);
  return {
    backend: effective.backend as PersistenceConfig["backend"],
    // Spread the full postgres sub-object (carries maxConnections, connectTimeout, etc.)
    // falling back to a minimal object when only the flat connectionString is available.
    postgres:
      effective.postgres ??
      (effective.connectionString ? { connectionString: effective.connectionString } : undefined),
    sqlite: effective.sqlite ?? (effective.dbPath ? { dbPath: effective.dbPath } : undefined),
  };
}

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
   * Load configuration from runtime config via the documented fallback chain.
   * See `buildPersistenceConfigFrom` for the resolution semantics. Static
   * because it doesn't depend on instance state.
   */
  private static loadConfiguration(): PersistenceConfig {
    return buildPersistenceConfigFrom(getConfiguration());
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
