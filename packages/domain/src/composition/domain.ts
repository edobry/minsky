/**
 * Domain Composition Root
 *
 * Portable bootstrap for the Minsky domain layer. Any entry point — CLI, MCP
 * server, ops service, reviewer, test scripts — can call createDomainContainer()
 * to get a fully initialized domain service graph.
 *
 * Configuration initialization is handled idempotently: if setupConfiguration()
 * has already been called (e.g., the CLI entry point initializes config at
 * module top-level for error-boundary and import-ordering reasons), the guard
 * skips. If not yet initialized, the bootstrap handles it.
 *
 * Does NOT call container.initialize() — the caller controls when async
 * services start. Call container.initialize() when you're ready to pay the
 * DB connection cost.
 *
 * @see mt#2098 — extract portable domain bootstrap
 * @see mt#2097 — operational topology epic
 */

import { TsyringeContainer } from "./container";
import type { AppContainerInterface } from "./types";
import { NoopClientCapabilityRegistry } from "../client-capabilities";
// Type-only import — erased at runtime, so the detection module still loads
// lazily (only when the resolver below first runs).
import type { RepositoryBackendInfo } from "../session/repository-backend-detection";

/**
 * Build a lazy, memoizing repository-backend resolver.
 *
 * Repository-backend detection is environment-dependent: with no
 * `repository.backend` in config it falls back to shelling out to
 * `git remote get-url origin` in `process.cwd()`. Running that EAGERLY at
 * container boot made every CLI command — including repo-orthogonal ones like
 * `config get` and `persistence migrate` — spawn git and crash (pre-mt#2460)
 * or leak `fatal: not a git repository` noise (post-mt#2460) when invoked
 * outside a git checkout, and broke deployed headless containers with no git
 * binary. Detection therefore runs ONLY when a consumer first calls
 * `getRepositoryBackend()` (mt#1428; supersedes mt#2460's boot-time
 * deferred-failure placeholder, which laziness makes unreachable).
 *
 * Successful detection is memoized; failures are NOT cached, so a transient
 * failure in a long-lived process (MCP server) can recover on a later call.
 *
 * The `detect` parameter is a test seam; production callers use the default.
 */
export function makeLazyRepositoryBackendResolver(
  detect?: () => Promise<RepositoryBackendInfo>
): () => Promise<RepositoryBackendInfo> {
  const detectFn =
    detect ??
    (async () => {
      const { getRepositoryBackendFromConfig } = await import(
        "../session/repository-backend-detection"
      );
      return getRepositoryBackendFromConfig();
    });
  let resolved: Promise<RepositoryBackendInfo> | undefined;
  return () => {
    resolved ??= detectFn().catch((err) => {
      resolved = undefined;
      throw err;
    });
    return resolved;
  };
}

/**
 * Create a container with all domain service factories registered.
 *
 * Handles configuration initialization idempotently — safe to call whether
 * or not setupConfiguration() has already been invoked. Does NOT call
 * initialize() — the caller controls when async services start.
 */
export async function createDomainContainer(): Promise<AppContainerInterface> {
  const { isConfigurationInitialized } = await import("../configuration");
  if (!isConfigurationInitialized()) {
    const { setupConfiguration } = await import("../config-setup");
    await setupConfiguration();
  }

  const container = new TsyringeContainer();

  // --- Infrastructure (async) ---

  // mt#3751: ONE PersistenceService instance, held in this closure for the
  // life of the container (not recreated per retry) — Step 1's trace found
  // that the pre-mt#3751 shape recreated a fresh `PersistenceService` on
  // EVERY retryDeferred() invocation (container.ts re-invokes this whole
  // factory function), discarding whatever retry bookkeeping the previous
  // attempt accumulated. `getProviderWithRetry()` (added this task, see
  // `persistence/service.ts`) needs a STABLE instance to track attempt
  // count / backoff / last-error against; a fresh instance every retry
  // always looks like "never attempted" to the reporting surface below,
  // which is the concrete mechanism behind the observed 2026-08-05 latch
  // (`persistence_check` showing "no re-initialization attempted since
  // boot" no matter how long the outage ran).
  let sharedPersistenceService: import("../persistence/service").PersistenceService | undefined;

  container.register(
    "persistence",
    async () => {
      const { log } = await import("@minsky/shared/logger");
      const { UnconfiguredPersistenceProvider } = await import(
        "../persistence/unconfigured-provider"
      );

      // Pre-check (mt#2349): if no Postgres connection is configured, boot in
      // DB-unavailable mode WITHOUT attempting (and error-logging) a doomed
      // initialize(). This is the expected bare-install / offline path now that
      // the silent SQLite fallback is gone — keep it quiet (warn, not error).
      const { getConfiguration } = await import("../configuration");
      const { getEffectivePersistenceConfig } = await import("../configuration/persistence-config");
      const effective = getEffectivePersistenceConfig(getConfiguration());
      if (effective.backend === "postgres" && !effective.connectionString) {
        log.warn(
          "Persistence not configured (no Postgres connection) — booting in " +
            "DB-unavailable mode. `/health` and non-DB commands work; DB-backed " +
            "operations fail until persistence.postgres.connectionString (or " +
            "MINSKY_POSTGRES_URL) is set."
        );
        // mt#2949: deliberately unconfigured (no connection string anywhere) —
        // the expected local/dev/offline boot path. `configuredButUnavailable`
        // stays false so `/health` (via assessPersistenceHealth) keeps
        // reporting healthy-but-degraded rather than failing the deploy.
        return new UnconfiguredPersistenceProvider("no Postgres connection configured", false);
      }

      const { PersistenceService } = await import("../persistence/service");
      // mt#3751: reuse the closure-scoped instance rather than constructing a
      // fresh one — see the comment above this factory's registration.
      sharedPersistenceService ??= new PersistenceService();
      const service = sharedPersistenceService;
      try {
        // mt#3751 / ADR-035 rule 1: retry-aware accessor. On the first call
        // this behaves exactly like the pre-mt#3751 initialize()+getProvider()
        // pair (attemptCount 0 -> always attempts). On a LATER call against an
        // already-degraded `service`, this transparently re-attempts
        // initialize() when backoff allows, instead of unconditionally
        // failing again — the self-heal this task adds.
        return await service.getProviderWithRetry();
      } catch (err) {
        // Boot-tolerant fallback (mt#2349): a connection WAS configured but
        // initialize() failed (DB unreachable, bad credentials, etc.). Still
        // don't crash the whole process — boot in DB-unavailable mode so
        // `/health` and other non-DB routes can still respond — but this is a
        // genuine failure (mt#2949: NOT the expected local/dev degraded mode),
        // so log loudly and mark the placeholder as `configuredButUnavailable`
        // so `/health` (assessPersistenceHealth), `validatePostgresBackend`,
        // and `createConfiguredTaskService` all fail loud instead of masking
        // it as a legitimate non-SQL backend. This is exactly the case that
        // made the 2026-07-19 outage invisible: /health returned 200 and
        // Railway reported SUCCESS while persistence was actually dead.
        const { getErrorMessage } = await import("../errors/index");
        const reason = getErrorMessage(err);
        log.error(
          "Persistence initialization failed — booting without a database " +
            `connection. DB-backed operations will fail. Reason: ${reason}`
        );
        const substitute = new UnconfiguredPersistenceProvider(reason, true);
        // mt#3751 amended SC4: populate the SAME retry-state contract
        // `validatePostgresBackend` already reads (ADR-035 rule 4), sourced
        // from the persistent `service` above rather than left empty. Only
        // when this failure came from an actual RETRY (attemptCount > 1) —
        // the very first (boot) failure must still render "no
        // re-initialization has been attempted since boot", exactly as
        // before this task.
        if (service.retryAttemptCount > 1 && service.lastRetryAttemptAt) {
          substitute.noteRetryAttempt(
            new Date(service.lastRetryAttemptAt),
            service.lastAttemptError ?? reason
          );
        }
        return substitute;
      }
    },
    {
      dispose: async (provider) => {
        await provider.close();
      },
    }
  );

  // --- Session layer (depends on persistence) ---

  container.register("sessionProvider", async (c) => {
    const { createSessionProvider } = await import("../session/drizzle-session-repository");
    const persistence = c.get("persistence");
    return await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => persistence,
      },
    });
  });

  // --- Domain services ---

  container.register("gitService", async (c) => {
    const { createGitService } = await import("../git/git-service-factory");
    return createGitService({ sessionProvider: c.get("sessionProvider") });
  });

  container.register("taskService", async (c) => {
    const { createConfiguredTaskService } = await import("../tasks/taskService");
    return createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: c.get("persistence"),
    });
  });

  container.register("taskGraphService", async (c) => {
    const { TaskGraphService } = await import("../tasks/task-graph-service");
    const persistence = c.get(
      "persistence"
    ) as import("../persistence/types").SqlCapablePersistenceProvider;
    const db = await persistence.getDatabaseConnection();
    return new TaskGraphService(db as import("drizzle-orm/postgres-js").PostgresJsDatabase);
  });

  container.register("taskRoutingService", async (c) => {
    const { TaskRoutingService } = await import("../tasks/task-routing-service");
    return new TaskRoutingService(c.get("taskGraphService"), c.get("taskService"));
  });

  container.register("workspaceUtils", async (c) => {
    const { createWorkspaceUtils } = await import("../workspace");
    return createWorkspaceUtils(c.get("sessionProvider"));
  });

  // The no-op is not just a default any more — since mt#4451 it is what this
  // key holds in production too. Nothing overrides it: the MCP server used to
  // swap in a registry that answered for every connected client at once, which
  // under ADR-038's shared daemon let one client's capabilities decide routing
  // for asks filed by all the others.
  //
  // Real host capabilities now reach the router per REQUEST, as
  // `CommandExecutionContext.callerCapabilities`, built from the connection that
  // made the call. So a consumer reading THIS key is a consumer with no
  // resolvable connection, and the no-op is the correct answer for it.
  container.register("clientCapabilityRegistry", () => new NoopClientCapabilityRegistry());

  // --- Composite: SessionDeps bundle ---

  container.register("sessionDeps", async (c) => {
    const { getCurrentSession } = await import("../workspace");
    const { execAsync } = await import("@minsky/shared/exec");
    const sessionProvider = c.get("sessionProvider");
    return {
      sessionProvider,
      gitService: c.get("gitService"),
      taskService: c.get("taskService"),
      workspaceUtils: c.get("workspaceUtils"),
      getCurrentSession: async (repoPath: string) => {
        const result = await getCurrentSession(repoPath, execAsync, sessionProvider);
        return result ?? null;
      },
      // Lazy: git-remote detection runs on first call, not at container boot
      // (mt#1428). Commands that never need a repo backend never spawn git.
      getRepositoryBackend: makeLazyRepositoryBackendResolver(),
    };
  });

  return container;
}
