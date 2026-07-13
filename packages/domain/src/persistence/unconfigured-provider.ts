/**
 * Unconfigured Persistence Provider (mt#2349)
 *
 * Boot-tolerant placeholder used when persistence initialization fails because
 * no Postgres connection is configured. Lets the process boot — so `/health`,
 * `config get`, and other non-DB commands work offline — while failing with a
 * clear "configure Postgres" error the moment a DB-backed operation is
 * attempted (fail-on-use, not fail-on-boot).
 *
 * This is the boot-tolerant counterpart to removing the former silent SQLite
 * fallback: we no longer silently write to a local SQLite file when no Postgres
 * is configured, but we also don't crash the whole process at boot for commands
 * that never touch the database. Its capabilities are all `false`, so
 * capability-gated consumers (e.g. the MCP wake-enrichment / OAuth helpers that
 * check `capabilities.sql`) skip it gracefully rather than hitting the throw.
 */

import { PersistenceProvider, type PersistenceCapabilities } from "./types";
import type { VectorStorage } from "../storage/vector/types";
import type { VectorDomain } from "../storage/schemas/embeddings-schema-factory";

/**
 * Thrown when a DB-backed operation is attempted but persistence is not
 * configured (no Postgres connection). Carries `bootDeferrable = true` so the
 * DI container's `initialize()` can defer the failure to use-time for services
 * whose construction needs the database — letting non-DB commands and `/health`
 * boot — while still failing fast on every OTHER (real wiring) error. The
 * marker is a structural property (not an import) so the generic container layer
 * stays decoupled from the persistence layer.
 */
export class PersistenceUnavailableError extends Error {
  readonly bootDeferrable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistenceUnavailableError";
  }
}

const NO_CAPABILITIES: PersistenceCapabilities = {
  sql: false,
  transactions: false,
  jsonb: false,
  vectorStorage: false,
  migrations: false,
};

export class UnconfiguredPersistenceProvider extends PersistenceProvider {
  readonly capabilities = NO_CAPABILITIES;

  /**
   * @param reason The underlying initialization error message (typically the
   *   "PostgreSQL configuration required" error from the provider factory).
   */
  constructor(private readonly reason: string) {
    super();
  }

  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  async initialize(): Promise<void> {
    // No-op: this provider represents the "could not initialize" state itself.
  }

  async close(): Promise<void> {
    // No-op: there is no underlying connection to release.
  }

  getConnectionInfo(): string {
    return "Unconfigured persistence (no Postgres connection — DB operations unavailable)";
  }

  private fail(): never {
    throw new PersistenceUnavailableError(
      `Persistence is not configured: ${this.reason} ` +
        "This operation requires a Postgres connection. Set " +
        "persistence.postgres.connectionString in config, or export " +
        "MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL)."
    );
  }

  async getDatabaseConnection(): Promise<unknown> {
    this.fail();
  }

  async getRawSqlConnection(): Promise<unknown> {
    this.fail();
  }

  getVectorStorageForDomain(_domain: VectorDomain, _dimension: number): VectorStorage {
    this.fail();
  }
}
