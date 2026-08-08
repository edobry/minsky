/**
 * Persistence Provider Factory
 *
 * Creates appropriate persistence provider based on configuration.
 */

import { PersistenceProvider, PersistenceConfig } from "./types";
import { PostgresProviderFactory } from "./providers/postgres-provider-factory";
import { log } from "@minsky/shared/logger";

/**
 * Convenience helper for hooks and scripts that need a one-shot DB connection.
 *
 * Creates, initializes, and returns the configured PersistenceProvider without
 * requiring a full DI container setup. Used by `.claude/hooks/` files that need
 * DB access (e.g., to record subagent invocations) but run outside the MCP server
 * process.
 *
 * Deliberately NOT process-lifetime-cached (mt#3751 Planning Audit): the
 * 2026-08-05 audit measured this function's lack of positive caching as a
 * real cost for hook processes (3 sequential resolves cost 5s+ combined), but
 * the Planning Audit explicitly severed that fix from this task — "the
 * hook-layer timeout/memoization is therefore a separate decision with its
 * own evidence, not a rider on this task." This function is shared by hooks
 * AND non-hook callers (`session start`, `asks.ts`), so caching it here would
 * change hook-process behavior too, which is exactly what was ruled out. The
 * one-shot-per-call shape stays as-is; `PersistenceService.getProviderWithRetry()`
 * (added this task) is available for a FUTURE caller that wants the cached,
 * backoff-gated behavior — see `packages/domain/src/composition/domain.ts`'s
 * persistence factory for the CLI/MCP-server consumer that now uses it.
 *
 * The caller is responsible for calling `provider.close()` when done.
 *
 * Returns `null` on any initialization error — callers should treat null as
 * "DB unavailable" and proceed without recording.
 *
 * The swallowed error is logged at debug level (mt#3019). It used to be
 * discarded entirely, which made two very different situations indistinguishable
 * at every call site: a genuinely unreachable database, and a caller that never
 * initialized the domain configuration system (a hook process — see
 * `.minsky/hooks/domain-bootstrap.ts`). The latter degraded silently for the
 * entire life of `record-subagent-invocation.ts`'s DB path; the one-line log
 * below is what makes that class diagnosable without re-deriving it from a bare
 * `null`.
 *
 * A debug log is only diagnosable where debug logs are READ, which a hook
 * process is not (mt#3750) — prefer `resolvePersistenceProviderOrError` below
 * when the caller needs to REPORT the cause rather than merely branch on it.
 */
export async function resolvePersistenceProvider(): Promise<PersistenceProvider | null> {
  const resolution = await resolvePersistenceProviderOrError();
  if (resolution.ok) {
    return resolution.provider;
  }
  log.debug("resolvePersistenceProvider: returning null after initialization error", {
    errorClass: resolution.errorClass,
    error: resolution.error,
  });
  return null;
}

/**
 * The outcome of a one-shot provider resolution: the live provider, or the
 * reason one could not be produced.
 *
 * `error` is ALWAYS credential-scrubbed. A driver or initialization message can
 * embed the connection string, and a DSN carries a password (PR #2178 R1); this
 * value is written into guard-health records, which are persisted and rendered
 * into an operator-facing banner, so it reaches more sinks than the debug log
 * that previously carried it.
 *
 * `errorClass` is the constructor name (or `typeof` for a non-Error throw). It
 * survives scrubbing unconditionally, so it discriminates the failure even in
 * the case where the message itself is redacted to nothing.
 */
export type PersistenceProviderResolution =
  | { ok: true; provider: PersistenceProvider }
  | { ok: false; error: string; errorClass: string };

/**
 * `resolvePersistenceProvider` with the failure reason preserved.
 *
 * A `PersistenceProvider | null` return cannot say WHY, so a caller that has to
 * report a cause must invent one — and the invented cause outlives the situation
 * that suggested it. `.minsky/hooks/standalone-dup-probe.ts` hardcoded
 * "persistence provider unavailable (see mt#3019 for the config-init class)" on
 * its null branch, a class its own control flow had already excluded (it reaches
 * that branch only after the domain bootstrap returns ok, i.e. after
 * configuration DID initialize). For three days a critical-escalation
 * guard-health streak pointed every reader at config init while the actual
 * error — a driver `CONNECT_TIMEOUT` — went only to this process's stderr, which
 * nothing reads (mt#3750).
 *
 * This is the same shape mt#3636 fixed one layer over: the discriminating detail
 * is carried on the returned value (`UnconfiguredPersistenceProvider`'s
 * `reason` + `configuredButUnavailable` there, `error` + `errorClass` here)
 * rather than collapsed into a flag the caller has to interpret. Per mem#769: a
 * pre-check that can fail for more than one reason must return the reason.
 *
 * `resolvePersistenceProvider` above delegates here and keeps its own
 * `| null` contract unchanged — this is additive, in the shape mt#3751 used for
 * `PersistenceService.getProviderWithRetry()`, because the null-returning
 * function is shared by hooks AND non-hook callers (`session start`, `asks.ts`).
 */
export async function resolvePersistenceProviderOrError(): Promise<PersistenceProviderResolution> {
  try {
    const { PersistenceService } = await import("./service");
    const service = new PersistenceService();
    await service.initialize();
    const provider = service.getProvider();
    if (!provider) {
      // Defensive: getProvider() throws when uninitialized (mt#3751 left that
      // contract untouched), so reaching here means initialize() reported
      // success and produced nothing — a state with no error to report, which
      // would otherwise be indistinguishable from a connect failure.
      return {
        ok: false,
        error: "persistence service initialized but produced no provider",
        errorClass: "NoProviderAfterInitialize",
      };
    }
    return { ok: true, provider };
  } catch (err) {
    const { scrubText } = await import("../transcripts/credential-scrubber");
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: scrubText(rawMessage).text,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    };
  }
}

/**
 * Factory for creating persistence providers
 */
export class PersistenceProviderFactory {
  /**
   * Create a persistence provider based on configuration
   * Async to support runtime capability detection
   */
  static async create(config: PersistenceConfig): Promise<PersistenceProvider> {
    log.debug(`Creating persistence provider for backend: ${config.backend}`);

    let provider: PersistenceProvider;

    switch (config.backend) {
      case "postgres":
        if (!config.postgres) {
          throw new Error(
            "PostgreSQL configuration required for postgres backend: " +
              "persistence.backend='postgres' but persistence.postgres is undefined. " +
              "Set persistence.postgres.connectionString in config, or export " +
              "MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL) as an env var."
          );
        }
        if (!config.postgres.connectionString || !config.postgres.connectionString.trim()) {
          throw new Error(
            "PostgreSQL configuration incomplete: persistence.postgres.connectionString is empty or whitespace. " +
              "Set it in config or export MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL)."
          );
        }
        // Use factory to create appropriate PostgreSQL provider based on runtime capabilities
        provider = await PostgresProviderFactory.create(config);
        break;

      default:
        throw new Error(`Unsupported persistence backend: ${config.backend}`);
    }

    log.info(`Persistence provider created: ${provider.constructor.name}`);
    return provider;
  }

  /**
   * Create a mock provider for testing
   */
  static createMock(
    capabilities?: Partial<PersistenceProvider["capabilities"]>
  ): PersistenceProvider {
    return new MockPersistenceProvider(capabilities);
  }
}

/**
 * Mock persistence provider for testing
 */
class MockPersistenceProvider extends PersistenceProvider {
  readonly capabilities: {
    sql: boolean;
    transactions: boolean;
    jsonb: boolean;
    vectorStorage: boolean;
    migrations: boolean;
  };

  constructor(private customCapabilities?: Partial<PersistenceProvider["capabilities"]>) {
    super();
    this.capabilities = {
      sql: false,
      transactions: false,
      jsonb: false,
      vectorStorage: false,
      migrations: false,
      ...customCapabilities,
    };
  }

  getCapabilities() {
    return this.capabilities;
  }

  async initialize(): Promise<void> {
    // No-op for mock
  }

  async getVectorStorage() {
    return null;
  }

  async getDatabaseConnection() {
    return null;
  }

  async close(): Promise<void> {
    // No-op for mock
  }

  getConnectionInfo(): string {
    return "Mock Provider (testing)";
  }
}
