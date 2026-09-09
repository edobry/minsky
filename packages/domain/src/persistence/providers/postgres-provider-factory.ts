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
  VectorExtensionAbsentError,
} from "../vector-capability-probe";
import {
  PostgresVectorPersistenceProvider,
  buildPostgresClient,
  CLOSE_TIMEOUT_SECONDS,
} from "./postgres-provider";

/**
 * Factory that constructs the PostgreSQL provider, ASSERTING pgvector rather than
 * branching on it (mt#5037).
 *
 * **This used to be a capability branch and is now a precondition check.** ADR-002
 * described pgvector as a runtime capability the product adapts to — returning a
 * reduced-capability `PostgresPersistenceProvider` when the extension was missing.
 * That branch was unreachable on any fresh install: the schema declares vector
 * columns and the bootstrap snapshot's first statement is
 * `CREATE EXTENSION IF NOT EXISTS vector`, so migration fails with SQLSTATE `0A000`
 * before a provider is ever constructed (measured on a stock `postgres:17`,
 * mt#5016). Both ADRs carry 2026-09-09 addenda; the decision is the principal's,
 * via ask#11882.
 *
 * **The probe was NOT deleted, and that is deliberate.** Hardcoding
 * `pgvectorVerified: true` would assert a capability nothing checked —
 * `PostgresVectorPersistenceProvider.initialize()` skips its own re-probe precisely
 * when this factory reports one already ran (mt#2973), so removing the query here
 * would leave NO check on either path. Under a hard requirement the probe matters
 * more, not less. What changed is what each outcome DOES:
 *
 * | outcome | before | now |
 * | --- | --- | --- |
 * | `present` | vector provider | vector provider (unchanged) |
 * | `absent` | base provider, silently degraded | `VectorExtensionAbsentError` — not retryable |
 * | `inconclusive` | `VectorCapabilityProbeInconclusiveError` | unchanged — still retryable |
 *
 * Keeping `absent` and `inconclusive` distinct is mt#3833's contribution and it
 * survives: they now both fail, but for different reasons and with different
 * remedies, so collapsing them would misreport the cause.
 */
export class PostgresProviderFactory {
  /**
   * Create the PostgreSQL provider, requiring pgvector.
   *
   * Returns a `PostgresVectorPersistenceProvider` or throws. The base
   * `PostgresPersistenceProvider` is still the class hierarchy's root and is still
   * constructed directly by tests and by the standalone path — it is simply no
   * longer reachable through this factory as a degraded fallback.
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
  ): Promise<PostgresVectorPersistenceProvider> {
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
      // mt#3833 established that this question has THREE answers, not two, and
      // mt#5037 changed what two of them DO. The three-way split survives because
      // "absent" and "inconclusive" now fail for DIFFERENT reasons: absent is a
      // fact about the deployment and is not retryable, inconclusive is a failure
      // to learn and IS retryable by the container. Collapsing them would report
      // the wrong cause and invite the wrong remedy.
      const probeOutcome = classifyVectorProbe(result);
      if (probeOutcome === "inconclusive") {
        throw new VectorCapabilityProbeInconclusiveError(describeProbeRows(result));
      }
      if (probeOutcome === "absent") {
        throw new VectorExtensionAbsentError();
      }

      // Hand the probed client to the provider for REUSE — do NOT end() it here.
      // The provider adopts it (its close() owns the lifecycle from now on).
      log.debug("Creating PostgreSQL provider with vector support (reusing probed connection)");
      return new PostgresVectorPersistenceProvider(config, {
        sql: probedSql,
        pgvectorVerified: true,
      });
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
      // mt#5037: distinguish a probe that FAILED from a probe that SUCCEEDED and
      // returned an unusable answer. Both reach this catch — the two capability
      // errors are thrown from inside the try so the pool cleanup above still runs
      // — but "Failed to test PostgreSQL capabilities" is false for them: the test
      // ran and answered. Reporting a successful probe as a failed one is the same
      // class of misleading record this task exists to fix, one layer down.
      const probeAnswered =
        error instanceof VectorExtensionAbsentError ||
        error instanceof VectorCapabilityProbeInconclusiveError;
      log.error(
        probeAnswered
          ? "PostgreSQL pgvector precondition not satisfied:"
          : "Failed to test PostgreSQL capabilities:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }
}
