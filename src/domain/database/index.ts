/**
 * Database Module Exports
 *
 * Central export point for all database-related services and adapters.
 * This module provides the shared database service and domain-specific adapters.
 */

// Export shared database service
export {
  SharedDatabaseService,
  getSharedDatabaseService,
  sharedDatabaseService,
  type ISharedDatabaseService,
  type DatabaseConfig,
  type MigrationConfig,
  type SharedDatabaseConfig,
  type DatabaseConnectionInfo,
} from "./shared-database-service";

// Export session database adapter
export { SessionDatabaseAdapter, type ISessionDatabaseAdapter } from "./session-database-adapter";

// Export task database adapter
export { TaskDatabaseAdapter, type ITaskDatabaseAdapter } from "./task-database-adapter";

// Export embeddings database adapter
export {
  EmbeddingsDatabaseAdapter,
  type IEmbeddingsDatabaseAdapter,
} from "./embeddings-database-adapter";

// Re-export legacy connection manager for backward compatibility
// This will be deprecated in favor of the shared database service
export { createDatabaseConnection, DatabaseConnectionManager } from "./connection-manager";

/**
 * Factory function to create all database adapters at once
 */
export function createDatabaseAdapters(service?: ISharedDatabaseService) {
  return {
    sessions: new SessionDatabaseAdapter(service),
    tasks: new TaskDatabaseAdapter(service),
    embeddings: new EmbeddingsDatabaseAdapter(service),
  };
}
