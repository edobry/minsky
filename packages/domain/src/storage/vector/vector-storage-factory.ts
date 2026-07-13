/**
 * Vector Storage Factory
 *
 * Creates vector storage instances using the persistence provider.
 * Uses dependency injection pattern with PersistenceProvider (required).
 *
 * The only API is createVectorStorageForDomain(domain, dimension, provider), which
 * routes each domain to its correct embeddings table (EMBEDDINGS_CONFIGS). Typed
 * per-domain helpers (createRulesVectorStorageFromConfig, createToolsVectorStorageFromConfig,
 * createMemoryVectorStorageFromConfig) hard-code the domain at definition time and
 * are equivalent to calling createVectorStorageForDomain directly.
 */

import type { VectorStorage } from "./types";
import { MemoryVectorStorage } from "./memory-vector-storage";
import type { PersistenceProvider } from "../../persistence/types";
import { log } from "@minsky/shared/logger";
import type { VectorDomain } from "../schemas/embeddings-schema-factory";

/**
 * Create vector storage for a specific domain using the persistence provider.
 * This is the preferred API — it routes each domain to its correct embeddings table
 * via EMBEDDINGS_CONFIGS, preventing cross-domain contamination.
 */
export async function createVectorStorageForDomain(
  domain: VectorDomain,
  dimension: number,
  persistenceProvider: PersistenceProvider
): Promise<VectorStorage> {
  if (!persistenceProvider.capabilities.vectorStorage) {
    log.warn(
      `[vector-storage] Provider does not support vector storage for domain "${domain}", using memory backend`
    );
    return new MemoryVectorStorage(dimension);
  }

  if (
    "getVectorStorageForDomain" in persistenceProvider &&
    typeof persistenceProvider.getVectorStorageForDomain === "function"
  ) {
    const vectorStorage = persistenceProvider.getVectorStorageForDomain(domain, dimension);
    if (!vectorStorage) {
      log.warn(
        `[vector-storage] Provider returned null for domain "${domain}", using memory backend`
      );
      return new MemoryVectorStorage(dimension);
    }
    return vectorStorage;
  }

  log.warn(`[vector-storage] Provider has no vector storage methods, using memory backend`);
  return new MemoryVectorStorage(dimension);
}

/**
 * Create a VectorStorage configured for rules embeddings.
 */
export async function createRulesVectorStorageFromConfig(
  dimension: number,
  persistenceProvider: PersistenceProvider
): Promise<VectorStorage> {
  return createVectorStorageForDomain("rules", dimension, persistenceProvider);
}

/**
 * Create a VectorStorage configured for tool embeddings.
 */
export async function createToolsVectorStorageFromConfig(
  dimension: number,
  persistenceProvider: PersistenceProvider
): Promise<VectorStorage> {
  return createVectorStorageForDomain("tools", dimension, persistenceProvider);
}

/**
 * Create a VectorStorage configured for memory embeddings.
 * Uses memories_embeddings table with memory_id as the id column.
 */
export async function createMemoryVectorStorageFromConfig(
  dimension: number,
  persistenceProvider: PersistenceProvider
): Promise<VectorStorage> {
  return createVectorStorageForDomain("memory", dimension, persistenceProvider);
}
