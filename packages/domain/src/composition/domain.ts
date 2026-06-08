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
      const { PersistenceService } = await import("../persistence/service");
      const service = new PersistenceService();
      await service.initialize();
      return service.getProvider();
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

  container.register("repositoryBackend", async () => {
    const { getRepositoryBackendFromConfig } = await import(
      "../session/repository-backend-detection"
    );
    return getRepositoryBackendFromConfig();
  });

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
