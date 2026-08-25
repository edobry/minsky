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
  backend: "postgres";
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
  /**
   * Pooler-guarded raw SQL access (mt#2773): `.unsafe()` is capped at
   * pool-max in-flight queries and returns plain rows (no PendingQuery
   * chaining). See raw-sql-pooler-guard.ts.
   */
  getRawSqlConnection?(): Promise<import("./raw-sql-pooler-guard").GuardedRawSql | null>;
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
  // Returns `unknown` at the base because subclasses return different concrete DB
  // types; callers that need typed connections should narrow via SqlCapablePersistenceProvider.
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

// ---------------------------------------------------------------------------
// Capability narrowing (mt#4543)
// ---------------------------------------------------------------------------

/**
 * Read a provider's declared capabilities, whatever shape it exposes them in.
 *
 * `PersistenceProvider` declares BOTH a `capabilities` property and a
 * `getCapabilities()` method, and the repo's test doubles are split between them —
 * so a guard that consults only one silently returns false for half the population.
 *
 * Fail-closed: anything this cannot read as a capabilities object yields `undefined`,
 * and every guard below treats that as "not capable". A provider that cannot answer
 * the question is not one to hand a connection request to.
 */
function readCapabilities(provider: unknown): PersistenceCapabilities | undefined {
  if (provider === null || typeof provider !== "object") return undefined;
  const candidate = provider as {
    getCapabilities?: unknown;
    capabilities?: unknown;
  };
  let fromMethod: unknown;
  if (typeof candidate.getCapabilities === "function") {
    try {
      fromMethod = (candidate.getCapabilities as () => unknown).call(candidate);
    } catch {
      // intentional-swallow: a provider whose own capability accessor throws cannot
      // answer the question, and fail-closed is the whole contract here. Falling
      // through to the property keeps a partially-broken double usable rather than
      // turning this guard into a throw site of its own.
      fromMethod = undefined;
    }
  }
  const raw = fromMethod ?? candidate.capabilities;
  if (raw === null || typeof raw !== "object") return undefined;
  return raw as PersistenceCapabilities;
}

/**
 * Is this provider SQL-capable? The ONE place that question is answered.
 *
 * **Two checks, and BOTH are load-bearing.** This is the correction that matters, because
 * the obvious reading of the defect is wrong in both directions:
 *
 * - **Method presence alone is insufficient.** `UnconfiguredPersistenceProvider` DEFINES
 *   `getDatabaseConnection()` — the body throws `PersistenceUnavailableError` — so
 *   `"getDatabaseConnection" in provider` passes for the exact provider it was written to
 *   catch. That is the defect mt#4543 exists to fix, across 44 sites.
 * - **Capability alone is ALSO insufficient.** A provider can declare `sql: true` and not
 *   implement the method; `startup-transcript-ingest.test.ts` pins exactly that case
 *   ("returns early when getDatabaseConnection is not available"), and a capability-only
 *   guard turns its early return into a `TypeError`. Found by that test, on this change.
 *
 * So the old idiom was INSUFFICIENT, not backwards — and a fix that merely swapped one
 * insufficient check for the other would have traded a throw-where-undefined-was-meant
 * for a different throw in the same place. Ask both: does it claim the capability, and
 * does it have the method the narrowed type promises.
 *
 * **Why a guard rather than the check inlined at each call site.** ADR-002 considered
 * and REJECTED "Runtime Capability Gating" — `if (!this.capabilities.X) throw` written
 * per call site — because it "requires discipline from all command developers" and gives
 * "no compile-time safety". Both objections are about the check being SPREAD, not about
 * the predicate itself: one type guard answers the question once and hands every call
 * site a narrowed type, which is the outcome ADR-002's `instanceof` prescription was
 * after. mem#1073 records the same lesson from the other direction — enforcing a
 * provider's invariant at one call site guarantees every other call site is wrong.
 *
 * **Deviation from ADR-002's literal mechanism, stated rather than glossed:** the ADR
 * says "capability checking with `instanceof`". A nominal check cannot live here —
 * `types.ts` is the base module its subclasses import, so naming them would be a cycle —
 * and `SqlCapablePersistenceProvider` is a STRUCTURAL type (`capabilities:
 * PersistenceCapabilities & { sql: true }`), which a type guard narrows to idiomatically.
 * The ADR's two stated objections are answered; its suggested implementation is not the
 * one available at this layer.
 */
export function isSqlCapable(provider: unknown): provider is SqlCapablePersistenceProvider {
  if (readCapabilities(provider)?.sql !== true) return false;
  return (
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function"
  );
}

/**
 * Is this provider vector-capable? Same contract as {@link isSqlCapable}, on the axis
 * ADR-002 was actually written about (`PostgresPersistenceProvider` vs
 * `PostgresVectorPersistenceProvider`).
 */
export function isVectorCapable(provider: unknown): provider is VectorCapablePersistenceProvider {
  if (readCapabilities(provider)?.vectorStorage !== true) return false;
  return (
    typeof (provider as { getVectorStorageForDomain?: unknown }).getVectorStorageForDomain ===
    "function"
  );
}

/**
 * Does this provider offer the pooler-guarded raw SQL connection?
 *
 * Two questions, and BOTH are load-bearing — which is why this is not simply
 * {@link isSqlCapable}. `getRawSqlConnection` is OPTIONAL on
 * `SqlCapablePersistenceProvider`, so a genuinely SQL-capable provider may not implement
 * it, and a method-presence check for it is meaningful rather than mistaken. What was
 * wrong at the 44 call sites was asking ONLY that: presence alone passes for the
 * unconfigured placeholder. Capability first, then presence.
 */
export function hasRawSqlConnection(
  provider: unknown
): provider is SqlCapablePersistenceProvider & {
  getRawSqlConnection: NonNullable<SqlCapablePersistenceProvider["getRawSqlConnection"]>;
} {
  if (!isSqlCapable(provider)) return false;
  return typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function";
}

/**
 * Does this provider offer a session-mode connection for LISTEN/NOTIFY (mt#1852)?
 * Same two-part contract as {@link hasRawSqlConnection}.
 */
export function hasListenCapableSqlConnection(
  provider: unknown
): provider is SqlCapablePersistenceProvider & {
  getListenCapableSqlConnection: NonNullable<
    SqlCapablePersistenceProvider["getListenCapableSqlConnection"]
  >;
} {
  if (!isSqlCapable(provider)) return false;
  return (
    typeof (provider as { getListenCapableSqlConnection?: unknown })
      .getListenCapableSqlConnection === "function"
  );
}
