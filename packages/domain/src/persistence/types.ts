/**
 * Persistence Provider Types
 *
 * Core interfaces and types for the persistence provider system.
 * Defines capabilities and contracts for different persistence backends.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { VectorStorage } from "../storage/vector/types";
import type { VectorDomain } from "../storage/schemas/embeddings-schema-factory";

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
  backend: "postgres" | "sqlite";
  postgres?: {
    connectionString: string;
    /**
     * Optional session-mode connection string for LISTEN/NOTIFY operations (mt#1852).
     * When unset, auto-derived by swapping :6543 → :5432 (Supavisor port-swap).
     */
    sessionConnectionString?: string;
    maxConnections?: number;
    connectTimeout?: number;
    idleTimeout?: number;
    prepareStatements?: boolean;
  };
  sqlite?: {
    dbPath: string;
  };
}

/**
 * Base interface for all persistence providers
 */
export interface BasePersistenceProvider {
  readonly capabilities: PersistenceCapabilities;
  getCapabilities(): PersistenceCapabilities;
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
  /**
   * Returns a session-mode-capable Sql instance, suitable for LISTEN/NOTIFY (mt#1852).
   *
   * Distinct from `getRawSqlConnection()` which returns the pooled transaction-mode
   * connection used for normal queries — Supavisor's transaction pooler (:6543)
   * does not support LISTEN because LISTEN state is per-connection and the pooler
   * may route each command to a different backend.
   *
   * The session-mode URL comes from `persistence.postgres.sessionConnectionString`
   * config (env: MINSKY_POSTGRES_SESSION_URL); falls back to a Supavisor port-swap
   * auto-derive (:6543 → :5432) from the transaction-pool URL when unset.
   *
   * Contract: returns a non-null Sql instance on success; throws when the provider
   * is not initialized or the underlying connection cannot be created. Never
   * returns null (unlike the pre-existing `getDatabaseConnection`/`getRawSqlConnection`
   * whose `| null` declarations are out of mt#1852's scope but never returned null
   * in practice — alignment tracked separately as mt#1858).
   */
  getListenCapableSqlConnection?(): Promise<ReturnType<typeof import("postgres")>>;
}

/**
 * Vector-capable persistence provider interface
 */
export interface VectorCapablePersistenceProvider extends BasePersistenceProvider {
  capabilities: PersistenceCapabilities & { vectorStorage: true };
  /** Routes to the correct embeddings table for the given domain */
  getVectorStorageForDomain(domain: VectorDomain, dimension: number): VectorStorage;
}

/**
 * Abstract base class for all persistence providers
 */
export abstract class PersistenceProvider implements BasePersistenceProvider {
  abstract readonly capabilities: PersistenceCapabilities;
  abstract getCapabilities(): PersistenceCapabilities;
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract getConnectionInfo(): string;

  // Optional capability methods — implemented by SQL/vector-capable subclasses.
  // Returns `unknown` because SQLite and PostgreSQL return different concrete DB types;
  // callers that need typed connections should narrow via SqlCapablePersistenceProvider.
  getDatabaseConnection?(): Promise<unknown>;
  getRawSqlConnection?(): Promise<unknown>;
  /** Session-mode-capable connection for LISTEN/NOTIFY (mt#1852). */
  getListenCapableSqlConnection?(): Promise<ReturnType<typeof import("postgres")>>;
  /** Routes to the correct embeddings table per domain */
  getVectorStorageForDomain?(domain: VectorDomain, dimension: number): VectorStorage;
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
