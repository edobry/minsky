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
import { getDefaultSqliteDbPath } from "../../utils/paths";
import { log } from "../../utils/logger";
import type { VectorStorage } from "../storage/vector/types";
import type { Configuration } from "../configuration/schemas";

/**
 * Pull tuning fields (maxConnections, timeouts, prepareStatements) from a legacy
 * `sessiondb.postgres.*` block, excluding `connectionString` so the caller can apply
 * precedence independently.
 */
function extractLegacyPostgresFields(config: Configuration): Record<string, unknown> {
  const legacy = (config as Configuration & { sessiondb?: { postgres?: Record<string, unknown> } })
    .sessiondb;
  const legacyPostgres = legacy?.postgres;
  if (!legacyPostgres || typeof legacyPostgres !== "object") return {};
  const { connectionString: _ignored, ...rest } = legacyPostgres as Record<string, unknown>;
  return rest;
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
   * Load configuration from runtime config.
   *
   * Unified resolution: reads both the modern `persistence.*` and legacy `sessiondb.*`
   * shapes plus env-var fallbacks via `getEffectivePersistenceConfig`, then rebuilds a
   * `PersistenceConfig` (the nested factory shape) so env-only deployments work.
   *
   * Prior behavior returned `runtimeConfig.persistence` directly, which always resolved
   * to the SQLite default when no `persistence.*` override existed — so
   * `MINSKY_SESSIONDB_*` env vars (populating `config.sessiondb.*`) had no effect at
   * bootstrap. See mt#1224.
   */
  private static loadConfiguration(): PersistenceConfig {
    const runtimeConfig = getConfiguration();
    const effective = getEffectivePersistenceConfig(runtimeConfig);

    switch (effective.backend) {
      case "postgres": {
        if (!effective.connectionString) {
          throw new Error(
            "Postgres persistence backend requires a connection string. Set " +
              "`persistence.postgres.connectionString` in config, or the " +
              "`MINSKY_PERSISTENCE_POSTGRES_URL` / `MINSKY_SESSIONDB_POSTGRES_URL` env var."
          );
        }
        const legacyPostgres = extractLegacyPostgresFields(runtimeConfig);
        return {
          backend: "postgres",
          postgres: {
            ...(runtimeConfig.persistence?.postgres ?? {}),
            ...legacyPostgres,
            connectionString: effective.connectionString,
          },
        };
      }
      case "sqlite": {
        return {
          backend: "sqlite",
          sqlite: {
            dbPath: effective.dbPath ?? getDefaultSqliteDbPath(),
          },
        };
      }
      default:
        throw new Error(`Unsupported persistence backend: ${String(effective.backend)}`);
    }
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
