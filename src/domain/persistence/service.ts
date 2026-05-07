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
import type { VectorDomain } from "../storage/schemas/embeddings-schema-factory";

/**
 * Build a PersistenceConfig from a Configuration.
 *
 * Resolution priority (see getEffectivePersistenceConfig):
 *   1. config.persistence.*
 *   2. MINSKY_POSTGRES_URL env var (connection string only)
 *   3. Hard-coded defaults (backend = sqlite, default sqlite path)
 *
 * Throws LegacySessiondbConfigError if the merged config still contains a
 * sessiondb: block (see mt#1610).
 *
 * Exported as a pure function so the env-var-only resolution path is unit-
 * testable without mocking the global configuration provider.
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
   * Get vector storage for a specific domain — preferred API.
   * Routes to the correct embeddings table via EMBEDDINGS_CONFIGS, preventing
   * cross-domain table contamination.
   */
  getVectorStorageForDomain(domain: VectorDomain, dimension: number): VectorStorage {
    const provider = this.getProvider();

    if (!this.isVectorCapable(provider)) {
      throw new CapabilityNotSupportedError("vectorStorage", provider.constructor.name);
    }

    return provider.getVectorStorageForDomain(domain, dimension);
  }

  /**
   * Get vector storage — type-safe approach using interface checking.
   *
   * @deprecated Use getVectorStorageForDomain(domain, dimension) to specify the
   * correct domain. This method defaults to the "tasks" domain, which is WRONG
   * for memory, rules, tools, and knowledge embeddings.
   */
  getVectorStorage(dimension: number): VectorStorage {
    return this.getVectorStorageForDomain("tasks", dimension);
  }

  private isVectorCapable(
    provider: PersistenceProvider
  ): provider is VectorCapablePersistenceProvider {
    return (
      provider.capabilities.vectorStorage === true &&
      "getVectorStorageForDomain" in provider &&
      typeof (provider as VectorCapablePersistenceProvider).getVectorStorageForDomain === "function"
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
