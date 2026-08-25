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
  classifyVectorProbe,
  describeProbeRows,
  VectorCapabilityProbeInconclusiveError,
} from "../vector-capability-probe";
import {
  PostgresPersistenceProvider,
  PostgresVectorPersistenceProvider,
  buildPostgresClient,
  CLOSE_TIMEOUT_SECONDS,
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
    config: PersistenceConfig,
    /**
     * Injected client builder, per ADR-026's `deps`-parameter convention
     * (mt#3833, PR #2766 R1).
     *
     * Production passes nothing and gets `buildPostgresClient`. The seam exists
     * because the branch this factory is being fixed for — an unreadable probe
     * result — cannot be produced against a healthy database on demand, so the
     * only way to exercise it is to hand the factory a client that returns the
     * shape. Injecting the builder is what ADR-036 prescribes over patching the
     * module import.
     */
    deps: { buildClient?: typeof buildPostgresClient } = {}
  ): Promise<PostgresPersistenceProvider | PostgresVectorPersistenceProvider> {
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresProviderFactory requires postgres configuration");
    }

    const pgConfig = config.postgres;
    const buildClient = deps.buildClient ?? buildPostgresClient;

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
    const probedSql = buildClient(pgConfig);

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

      // mt#3833: three outcomes, not two. `result[0]?.exists ?? false` used to
      // render "the probe did not answer" as "the extension is absent", and the
      // resulting provider — successfully constructed, merely less capable — was
      // memoized for the process lifetime with nothing to retry it, because
      // nothing had failed. Propagating instead is ADR-035 rule 1's first
      // remedy, and it reuses the container's existing retry rather than
      // re-deriving one here.
      const probeOutcome = classifyVectorProbe(result);
      if (probeOutcome === "inconclusive") {
        throw new VectorCapabilityProbeInconclusiveError(describeProbeRows(result));
      }
      const hasVectorExtension = probeOutcome === "present";

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
      // avoid leaking the pool. Guard the cleanup so an end() failure can't mask
      // the original probe error (matches the provider's initialize() catch).
      // Bounded (mt#4515, PR #3308 R1): guarding against a THROW does not guard
      // against a HANG, and an unbounded end() on a probe that just failed —
      // quite possibly because the connection is half-open — never settles. That
      // would stall boot itself, since this runs on the cold-start path.
      try {
        await probedSql.end({ timeout: CLOSE_TIMEOUT_SECONDS });
      } catch {
        /* ignore cleanup errors */
      }
      log.error(
        "Failed to test PostgreSQL capabilities:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }
}
