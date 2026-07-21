/**
 * PostgreSQL Provider Factory
 *
 * Creates the appropriate PostgreSQL provider class based on runtime capabilities
 */

import { log } from "@minsky/shared/logger";
import { profileCheckpoint } from "@minsky/shared/cold-start-profile";
import { PersistenceConfig } from "../types";
import { withPgPoolRetry } from "../postgres-retry";
import {
  PostgresPersistenceProvider,
  PostgresVectorPersistenceProvider,
  buildPostgresClient,
} from "./postgres-provider";

/**
 * Factory that decides which PostgreSQL provider to create based on pgvector availability
 */
export class PostgresProviderFactory {
  /**
   * Create the appropriate PostgreSQL provider based on runtime capabilities
   * Returns PostgresVectorPersistenceProvider if pgvector available, otherwise base PostgresPersistenceProvider
   */
  static async create(
    config: PersistenceConfig
  ): Promise<PostgresPersistenceProvider | PostgresVectorPersistenceProvider> {
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresProviderFactory requires postgres configuration");
    }

    const pgConfig = config.postgres;

    // mt#2973: create the REAL production client (not a throwaway max:1 probe
    // connection) and run the capability probe on it, then hand the SAME
    // already-open, SELECT-1-validated client to the provider for reuse. This
    // collapses the former TWO cold-boot handshakes (throwaway probe + the
    // provider's own connect) into ONE, saving ~486ms/boot. postgres-js opens
    // connections lazily and reuses them within a client
    // (github.com/porsager/postgres — "previous opened connection is reused"),
    // so the probe query opens the pool's first connection and the provider
    // keeps using it. `onnotice` (inside buildPostgresClient) keeps stdout clean
    // (mt#1827/mt#1828).
    profileCheckpoint("pg_probe_start");
    const probedSql = buildPostgresClient(pgConfig);

    try {
      // First (and now ONLY) remote handshake of the cold boot: postgres()
      // connects lazily, so the TLS handshake to the pooler happens on this
      // query. Retry on pool saturation, matching the provider's own SELECT 1.
      await withPgPoolRetry(() => probedSql`SELECT 1`, "postgres-provider-factory.probe");
      profileCheckpoint("pg_probe_connect_and_select1");

      // Check for pgvector extension (on the same connection the provider reuses).
      const result = await probedSql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;
      profileCheckpoint("pg_probe_pgvector");

      const hasVectorExtension = result[0]?.exists ?? false;

      // Hand the probed client to the provider for REUSE — do NOT end() it here.
      // The provider adopts it (its close() owns the lifecycle from now on).
      if (hasVectorExtension) {
        log.debug("Creating PostgreSQL provider with vector support (reusing probed connection)");
        return new PostgresVectorPersistenceProvider(config, {
          sql: probedSql,
          pgvectorVerified: true,
        });
      } else {
        log.debug(
          "Creating PostgreSQL provider without vector support " +
            "(pgvector not available; reusing probed connection)"
        );
        return new PostgresPersistenceProvider(config, {
          sql: probedSql,
          pgvectorVerified: false,
        });
      }
    } catch (error) {
      // The probe failed before any provider adopted the client — end it here to
      // avoid leaking the pool.
      await probedSql.end();
      log.error(
        "Failed to test PostgreSQL capabilities:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }
}
