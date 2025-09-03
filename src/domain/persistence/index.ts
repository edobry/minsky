/**
 * Persistence Module
 *
 * Central export point for persistence provider system.
 */

// Export types
export {
  PersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
  DatabaseStorage,
  CapabilityNotSupportedError,
} from "./types";

// Re-export VectorStorage from the storage module for convenience
export type { VectorStorage } from "../storage/vector/types";

// Export providers
export { PostgresPersistenceProvider } from "./providers/postgres-provider";
export { SqlitePersistenceProvider } from "./providers/sqlite-provider";
export { JsonPersistenceProvider } from "./providers/json-provider";

// Export factory
export { PersistenceProviderFactory } from "./factory";

// Export service
export { PersistenceService, getPersistenceProvider } from "./service";
