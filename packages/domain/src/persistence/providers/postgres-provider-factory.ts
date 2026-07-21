/**
 * PostgreSQL Provider Factory
 *
 * Creates the appropriate PostgreSQL provider class based on runtime capabilities
 */

import postgres from "postgres";
import { log } from "@minsky/shared/logger";
import { profileCheckpoint } from "@minsky/shared/cold-start-profile";
import { logPostgresNotice } from "../postgres-notice-handler";
import { PersistenceConfig } from "../types";
import {
  PostgresPersistenceProvider,
  PostgresVectorPersistenceProvider,
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

    // Test connection and check for pgvector extension. `onnotice` routes
    // through the shared logger so the cold-path probe doesn't leak Postgres
    // NOTICEs to stdout (mt#1828; pairs with mt#1827's main-pool fix).
    profileCheckpoint("pg_probe_start");
    const testSql = postgres(pgConfig.connectionString, {
      max: 1, // Just need one connection for testing
      connect_timeout: pgConfig.connectTimeout || 10,
      onnotice: logPostgresNotice,
    });

    try {
      // Verify connection works. This is the FIRST remote handshake of the
      // cold boot — `postgres()` connects lazily, so the TLS handshake to the
      // pooler happens on this query (mt#2973 measures it here).
      await testSql`SELECT 1`;
      profileCheckpoint("pg_probe_connect_and_select1");

      // Check for pgvector extension
      const result = await testSql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;
      profileCheckpoint("pg_probe_pgvector");

      await testSql.end(); // Clean up test connection
      profileCheckpoint("pg_probe_end");

      const hasVectorExtension = result[0]?.exists;

      if (hasVectorExtension) {
        log.debug("Creating PostgreSQL provider with vector support");
        return new PostgresVectorPersistenceProvider(config);
      } else {
        log.debug("Creating PostgreSQL provider without vector support (pgvector not available)");
        return new PostgresPersistenceProvider(config);
      }
    } catch (error) {
      await testSql.end(); // Clean up on error
      log.error(
        "Failed to test PostgreSQL capabilities:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }
}
