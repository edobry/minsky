/**
 * Persistence Provider Types
 *
 * Core interfaces and types for the persistence provider system.
 * Defines capabilities and contracts for different persistence backends.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { VectorStorage } from "../storage/vector/types";
import type { DatabaseStorage as StorageDatabaseStorage } from "../storage/database-storage";
import type { SessionRecord, SessionDbState } from "../session/session-db";

/**
 * Capabilities exposed by different persistence providers
 */
export interface PersistenceCapabilities {
  sql: boolean; // Supports SQL queries
  transactions: boolean; // ACID transaction support
  jsonb: boolean; // JSONB column type and operators
  vectorStorage: boolean; // pgvector extension available
  migrations: boolean; // Can run Drizzle migrations
}

/**
 * Configuration for different persistence backends
 */
export interface PersistenceConfig {
  backend: "postgres" | "sqlite" | "json";
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
 * Re-export DatabaseStorage from storage module for use by providers.
 * The canonical DatabaseStorage interface lives in storage/database-storage.ts.
 */
export type { StorageDatabaseStorage as DatabaseStorage };

/**
 * Session storage type alias — makes the persistence layer explicit about
 * the single entity type it currently stores.  Uses a type-only import so
 * there is no runtime dependency on the session module.
 */
export type SessionStorage = StorageDatabaseStorage<SessionRecord, SessionDbState>;

/**
 * Base interface for all persistence providers
 */
export interface BasePersistenceProvider {
  readonly capabilities: PersistenceCapabilities;
  getCapabilities(): PersistenceCapabilities;
  getStorage(): SessionStorage;
  initialize(): Promise<void>;
  close(): Promise<void>;
  getConnectionInfo(): string;
}

/**
 * SQL-capable persistence provider interface
 */
export interface SqlCapablePersistenceProvider extends BasePersistenceProvider {
  capabilities: PersistenceCapabilities & { sql: true };
  getDatabaseConnection(): Promise<PostgresJsDatabase | null>;
  getRawSqlConnection?(): Promise<ReturnType<typeof import("postgres")> | null>;
}

/**
 * Vector-capable persistence provider interface
 */
export interface VectorCapablePersistenceProvider extends BasePersistenceProvider {
  capabilities: PersistenceCapabilities & { vectorStorage: true };
  getVectorStorage(dimension: number): VectorStorage;
}

/**
 * Abstract base class for all persistence providers
 */
export abstract class PersistenceProvider implements BasePersistenceProvider {
  abstract readonly capabilities: PersistenceCapabilities;
  abstract getCapabilities(): PersistenceCapabilities;
  abstract getStorage(): SessionStorage;
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract getConnectionInfo(): string;

  // Optional capability methods — implemented by SQL/vector-capable subclasses.
  // Base class uses `unknown` because SQLite and PostgreSQL return different concrete
  // DB types; callers that need typed connections should narrow via SqlCapablePersistenceProvider.
  getDatabaseConnection?(): Promise<unknown>;
  getRawSqlConnection?(): Promise<unknown>;
  getVectorStorage?(dimension: number): VectorStorage | Promise<VectorStorage | null>;
}

/**
 * Error thrown when a capability is not supported
 */
export class CapabilityNotSupportedError extends Error {
  constructor(capability: keyof PersistenceCapabilities, provider: string) {
    super(`Capability '${capability}' is not supported by ${provider} provider`);
    this.name = "CapabilityNotSupportedError";
  }
}
