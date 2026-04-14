/**
 * Vector Storage Factory
 *
 * Creates vector storage instances using the persistence provider.
 * Updated to use dependency injection pattern with PersistenceProvider.
 */

import type { VectorStorage } from "./types";
import { MemoryVectorStorage } from "./memory-vector-storage";
import type { PersistenceProvider } from "../../persistence/types";
import { log } from "../../../utils/logger";

/**
 * Create vector storage using persistence provider
 */
export async function createVectorStorageFromConfig(
  dimension: number,
  persistenceProvider?: PersistenceProvider
): Promise<VectorStorage> {
  // Use injected provider or fall back to PersistenceService singleton
  let provider: PersistenceProvider;
  if (persistenceProvider) {
    provider = persistenceProvider;
  } else {
    const { PersistenceService } = await import("../../persistence/service");
    provider = PersistenceService.getProvider();
  }

  // Check if provider supports vector storage
  if (!provider.capabilities.vectorStorage) {
    log.warn("Current persistence provider does not support vector storage, using memory backend");
    return new MemoryVectorStorage(dimension);
  }

  // Get vector storage from provider
  const vectorStorage = await provider.getVectorStorage?.(dimension);

  if (!vectorStorage) {
    log.warn("Provider returned null for vector storage, using memory backend");
    return new MemoryVectorStorage(dimension);
  }

  return vectorStorage;
}

/**
 * Create a VectorStorage configured for rules embeddings.
 * Domain-specific convenience that keeps vector storage generic.
 */
export async function createRulesVectorStorageFromConfig(
  dimension: number,
  persistenceProvider?: PersistenceProvider
): Promise<VectorStorage> {
  // For now, use the same implementation as tasks
  // In the future, this could create a separate vector storage instance
  // with different table/collection names
  return createVectorStorageFromConfig(dimension, persistenceProvider);
}

/**
 * Create a VectorStorage configured for tool embeddings.
 * Domain-specific convenience for tools embeddings.
 */
export async function createToolsVectorStorageFromConfig(
  dimension: number,
  persistenceProvider?: PersistenceProvider
): Promise<VectorStorage> {
  // For now, use the same implementation as tasks
  // In the future, this could create a separate vector storage instance
  // with different table/collection names
  return createVectorStorageFromConfig(dimension, persistenceProvider);
}

/** Minimal interface for providers that may offer vector storage, avoiding circular dependency */
interface VectorCapableProvider {
  capabilities?: { vectorStorage?: boolean };
  getVectorStorage?(dimension: number): Promise<VectorStorage | null> | VectorStorage | null;
}

/**
 * Create vector storage with explicit persistence provider
 * (for testing or when you need to specify a particular provider)
 */
export async function createVectorStorage(
  provider: VectorCapableProvider,
  dimension: number
): Promise<VectorStorage> {
  if (!provider.capabilities?.vectorStorage) {
    return new MemoryVectorStorage(dimension);
  }

  const vectorStorage = await provider.getVectorStorage?.(dimension);
  return vectorStorage || new MemoryVectorStorage(dimension);
}
