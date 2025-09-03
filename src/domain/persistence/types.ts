/**
 * Persistence Provider Types
 *
 * Core interfaces and types for the persistence provider system.
 * Defines capabilities and contracts for different persistence backends.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Capabilities exposed by different persistence providers
 */
export interface PersistenceCapabilities {
  sql: boolean;              // Supports SQL queries
  transactions: boolean;     // ACID transaction support
  jsonb: boolean;           // JSONB column type and operators
  vectorStorage: boolean;   // pgvector extension available
  migrations: boolean;      // Can run Drizzle migrations
}

/**
 * Configuration for different persistence backends
 */
export interface PersistenceConfig {
  backend: 'postgres' | 'sqlite' | 'json';
  postgres?: {
    connectionString: string;
    maxConnections?: number;
    connectTimeout?: number;
    idleTimeout?: number;
    prepareStatements?: boolean;
  };
  sqlite?: {
    dbPath: string;
  };
  json?: {
    filePath: string;
  };
}

/**
 * Storage interface for domain entities
 */
export interface DatabaseStorage<T, S> {
  get(id: string): Promise<T | null>;
  save(id: string, data: T): Promise<void>;
  update(id: string, updates: Partial<T>): Promise<void>;
  delete(id: string): Promise<void>;
  search(criteria: S): Promise<T[]>;
}

/**
 * Vector storage interface for embeddings
 */
export interface VectorStorage {
  store(id: string, embedding: number[], metadata?: Record<string, any>): Promise<void>;
  search(embedding: number[], limit: number): Promise<Array<{
    id: string;
    distance: number;
    metadata?: Record<string, any>;
  }>>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Abstract base class for all persistence providers
 */
export abstract class PersistenceProvider {
  /**
   * Capabilities of this persistence provider
   */
  abstract readonly capabilities: PersistenceCapabilities;

  /**
   * Get storage instance for domain entities
   */
  abstract getStorage<T, S>(): DatabaseStorage<T, S>;

  /**
   * Get vector storage instance (if supported)
   */
  abstract getVectorStorage?(dimension: number): Promise<VectorStorage | null>;

  /**
   * Get direct database connection (if SQL-based)
   */
  abstract getDatabaseConnection?(): Promise<PostgresJsDatabase | null>;

  /**
   * Initialize the provider
   */
  abstract initialize(): Promise<void>;

  /**
   * Close all connections
   */
  abstract close(): Promise<void>;

  /**
   * Get connection information for debugging
   */
  abstract getConnectionInfo(): string;
}

/**
 * Error thrown when a capability is not supported
 */
export class CapabilityNotSupportedError extends Error {
  constructor(capability: keyof PersistenceCapabilities, provider: string) {
    super(`Capability '${capability}' is not supported by ${provider} provider`);
    this.name = 'CapabilityNotSupportedError';
  }
}
