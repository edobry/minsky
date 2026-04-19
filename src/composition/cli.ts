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

import { AppContainer } from "./container";
import type { AppContainerInterface } from "./types";

/**
 * Create a container with real service factories for CLI usage.
 * Does NOT call initialize() — the caller controls when async services start.
 */
export async function createCliContainer(): Promise<AppContainerInterface> {
  const container = new AppContainer();

  // --- Infrastructure (async) ---

  container.register(
    "persistence",
    async () => {
      // Use the defaultInstance during migration — code that hasn't been
      // migrated to container access still uses defaultInstance.getProvider().
      // Once all callers use the container, this can create a fresh instance.
      const { defaultInstance } = await import("../domain/persistence/service");
      await defaultInstance.initialize();
      return defaultInstance.getProvider();
    },
    {
      dispose: async () => {
        const { defaultInstance } = await import("../domain/persistence/service");
        await defaultInstance.close();
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

  container.register("gitService", async () => {
    const { createGitService } = await import("../domain/git/git-service-factory");
    return createGitService();
  });

  container.register("taskService", async (c) => {
    const { createConfiguredTaskService } = await import("../domain/tasks/taskService");
    return createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: c.get("persistence"),
    });
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
