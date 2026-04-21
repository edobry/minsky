/**
 * CLI Composition Root
 *
 * Builds an AppContainer configured for CLI usage: real service implementations
 * with deferred initialization. The container's initialize() is called from the
 * preAction hook in cli.ts, so help display and command parsing don't pay the
 * DB connection cost.
 *
 * This replaces the ad-hoc PersistenceService.initialize() + ensurePersistence()
 * pattern that was scattered across cli.ts.
 *
 * @see mt#761 spec, "Phase 2: Create composition roots and wire CLI"
 */

import { TsyringeContainer } from "./container";
import type { AppContainerInterface } from "./types";

/**
 * Create a container with real service factories for CLI usage.
 * Does NOT call initialize() — the caller controls when async services start.
 */
export async function createCliContainer(): Promise<AppContainerInterface> {
  const container = new TsyringeContainer();

  // --- Infrastructure (async) ---

  container.register(
    "persistence",
    async () => {
      const { PersistenceService } = await import("../domain/persistence/service");
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
    const { createSessionProvider } = await import("../domain/session/session-db-adapter");
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
    const { createGitService } = await import("../domain/git/git-service-factory");
    return createGitService({ sessionProvider: c.get("sessionProvider") });
  });

  container.register("taskService", async (c) => {
    const { createConfiguredTaskService } = await import("../domain/tasks/taskService");
    return createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: c.get("persistence"),
    });
  });

  container.register("taskGraphService", async (c) => {
    const { TaskGraphService } = await import("../domain/tasks/task-graph-service");
    const persistence = c.get(
      "persistence"
    ) as import("../domain/persistence/types").SqlCapablePersistenceProvider;
    const db = await persistence.getDatabaseConnection();
    return new TaskGraphService(db as import("drizzle-orm/postgres-js").PostgresJsDatabase);
  });

  container.register("taskRoutingService", async (c) => {
    const { TaskRoutingService } = await import("../domain/tasks/task-routing-service");
    return new TaskRoutingService(c.get("taskGraphService"), c.get("taskService"));
  });

  container.register("workspaceUtils", async (c) => {
    const { createWorkspaceUtils } = await import("../domain/workspace");
    return createWorkspaceUtils(c.get("sessionProvider"));
  });

  container.register("repositoryBackend", async () => {
    const { getRepositoryBackendFromConfig } = await import(
      "../domain/session/repository-backend-detection"
    );
    return getRepositoryBackendFromConfig();
  });

  // --- Composite: SessionDeps bundle ---

  container.register("sessionDeps", async (c) => {
    const { getCurrentSession } = await import("../domain/workspace");
    const { execAsync } = await import("../utils/exec");
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
