/**
 * Vector Storage Factory
 *
 * Creates vector storage instances using the persistence provider.
 * Uses dependency injection pattern with PersistenceProvider (required).
 *
 * The preferred API is createVectorStorageForDomain(domain, dimension, provider)
 * which routes each domain to its correct embeddings table (EMBEDDINGS_CONFIGS).
 * The legacy createVectorStorageFromConfig() defaults to "tasks" domain for
 * backward compatibility but should not be used for non-task domains.
 */

import type { VectorStorage } from "./types";
import { MemoryVectorStorage } from "./memory-vector-storage";
import type { PersistenceProvider } from "../../persistence/types";
import { log } from "../../../utils/logger";
import type { VectorDomain } from "../schemas/embeddings-schema-factory";

/** Minimal interface for providers that may offer domain-routed vector storage */
interface VectorCapableProvider {
  capabilities?: { vectorStorage?: boolean };
  getVectorStorageForDomain?(domain: VectorDomain, dimension: number): VectorStorage | null;
  /** @deprecated */
  getVectorStorage?(dimension: number): Promise<VectorStorage | null> | VectorStorage | null;
}

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

  // Prefer getVectorStorageForDomain (correct API), fall back to legacy getVectorStorage.
  // Use "in" narrowing to avoid `as unknown` cast — the abstract PersistenceProvider
  // declares getVectorStorageForDomain? as an optional method, so "in" narrowing is sufficient.
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

  // Legacy fallback: only correct for "tasks" domain
  if (domain !== "tasks") {
    log.warn(
      `[vector-storage] Provider lacks getVectorStorageForDomain; falling back to legacy ` +
        `getVectorStorage() for domain "${domain}" — this is INCORRECT and will use tasks_embeddings`
    );
  }
  if (
    "getVectorStorage" in persistenceProvider &&
    typeof persistenceProvider.getVectorStorage === "function"
  ) {
    const vectorStorage = await persistenceProvider.getVectorStorage(dimension);
    if (!vectorStorage) {
      log.warn(`[vector-storage] Provider returned null for vector storage, using memory backend`);
      return new MemoryVectorStorage(dimension);
    }
    return vectorStorage;
  }
  log.warn(`[vector-storage] Provider has no vector storage methods, using memory backend`);
  return new MemoryVectorStorage(dimension);
}

/**
 * Create vector storage using persistence provider.
 *
 * @deprecated Use createVectorStorageForDomain(domain, dimension, provider) to avoid
 * cross-domain table contamination. This function defaults to the "tasks" domain.
 */
export async function createVectorStorageFromConfig(
  dimension: number,
  persistenceProvider: PersistenceProvider
): Promise<VectorStorage> {
  return createVectorStorageForDomain("tasks", dimension, persistenceProvider);
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

/**
 * Create vector storage with explicit persistence provider
 * (for testing or when you need to specify a particular provider)
 *
 * @deprecated Use createVectorStorageForDomain() instead.
 */
export async function createVectorStorage(
  provider: VectorCapableProvider,
  dimension: number
): Promise<VectorStorage> {
  if (!provider.capabilities?.vectorStorage) {
    return new MemoryVectorStorage(dimension);
  }

  if (typeof provider.getVectorStorageForDomain === "function") {
    const vectorStorage = provider.getVectorStorageForDomain("tasks", dimension);
    return vectorStorage ?? new MemoryVectorStorage(dimension);
  }

  const vectorStorage = await provider.getVectorStorage?.(dimension);
  return vectorStorage ?? new MemoryVectorStorage(dimension);
}
