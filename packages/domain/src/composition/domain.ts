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
import type { AppContainerInterface, AppServices } from "./types";
import { NoopClientCapabilityRegistry } from "../client-capabilities";

/**
 * Build the deferred-failure placeholder for `repositoryBackend` when
 * detection fails at boot.
 *
 * `repositoryBackend` is a plain VALUE OBJECT (`repoUrl`, `backendType`, …),
 * not a method-bearing service, so the container's generic placeholder —
 * which returns callable stubs on property reads and only throws when one is
 * CALLED — would let `placeholder.repoUrl` silently yield a function instead
 * of a string. This placeholder instead throws on data-field reads so the
 * deferred failure surfaces deterministically at first use. Inspection stays
 * benign: symbols, `then` (so `await` works), and `constructor` return
 * undefined; `toString`/`valueOf`/`toJSON` return a safe stringifier.
 */
function makeDeferredRepositoryBackendPlaceholder(
  message: string
): AppServices["repositoryBackend"] {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then" || prop === "constructor") {
          return undefined;
        }
        if (prop === "toString" || prop === "valueOf" || prop === "toJSON") {
          return () => `[unavailable repositoryBackend: ${message}]`;
        }
        throw new Error(
          `Service "repositoryBackend" is unavailable: repository-backend detection ` +
            `failed at boot. ${message}`
        );
      },
    }
  ) as AppServices["repositoryBackend"];
}

/**
 * Resolve repository-backend config for container boot, deferring detection
 * failures to first use.
 *
 * Detection is environment-dependent: with no `repository.backend` in config
 * it falls back to shelling out to `git remote get-url origin`, which cannot
 * succeed in a deployed headless container (no git binary, and /app is a
 * Docker COPY tree with no .git). That is a missing-resource condition, not a
 * wiring bug — return a throws-on-read placeholder (same boot-tolerance
 * posture as the persistence factory above) so entry points that never touch
 * the repository backend (e.g. the reviewer service) still boot. See mt#2460.
 *
 * The `detect` parameter is a test seam; production callers use the default.
 */
export async function resolveRepositoryBackendForBoot(
  detect?: () => Promise<AppServices["repositoryBackend"]>
): Promise<AppServices["repositoryBackend"]> {
  const detectFn =
    detect ??
    (async () => {
      const { getRepositoryBackendFromConfig } = await import(
        "../session/repository-backend-detection"
      );
      return getRepositoryBackendFromConfig();
    });
  try {
    return await detectFn();
  } catch (err) {
    const { getErrorMessage } = await import("../errors/index");
    const { log } = await import("@minsky/shared/logger");
    const reason = getErrorMessage(err);
    log.warn(
      "Repository-backend detection failed — booting without a repository " +
        `backend. Operations that need it will fail on first use. Reason: ${reason}`
    );
    return makeDeferredRepositoryBackendPlaceholder(reason);
  }
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
        return new UnconfiguredPersistenceProvider("no Postgres connection configured");
      }

      const { PersistenceService } = await import("../persistence/service");
      const service = new PersistenceService();
      try {
        await service.initialize();
        return service.getProvider();
      } catch (err) {
        // Boot-tolerant fallback (mt#2349): a connection WAS configured but
        // initialize() failed (DB unreachable, bad credentials, etc.). Still
        // don't crash the whole process — boot in DB-unavailable mode so
        // `/health` responds — but this is a genuine failure, so the underlying
        // error is already logged by PersistenceService. DB-backed operations
        // fail with the clear error on first use.
        const { getErrorMessage } = await import("../errors/index");
        const reason = getErrorMessage(err);
        log.warn(
          "Persistence initialization failed — booting without a database " +
            `connection. DB-backed operations will fail. Reason: ${reason}`
        );
        return new UnconfiguredPersistenceProvider(reason);
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

  container.register("repositoryBackend", () => resolveRepositoryBackendForBoot());

  // Default ClientCapabilityRegistry is the no-op implementation. Entry
  // points that attach an MCP host (e.g., the MCP server) override this
  // with a per-connection-aware registry after container creation.
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
      getRepositoryBackend: async () => c.get("repositoryBackend"),
    };
  });

  return container;
}
