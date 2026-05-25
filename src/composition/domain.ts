/**
 * Domain Composition Root
 *
 * Portable bootstrap for the Minsky domain layer. Any entry point — CLI, MCP
 * server, ops service, reviewer, test scripts — can call createDomainContainer()
 * to get a fully initialized domain service graph.
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
import { NoopClientCapabilityRegistry } from "../mcp/client-capabilities";

export interface DomainContainerOptions {
  /**
   * Skip configuration setup. Use when the caller has already called
   * setupConfiguration() with its own error boundary (e.g., the CLI
   * entry point in cli.ts).
   */
  skipConfigSetup?: boolean;
}

/**
 * Create a container with all domain service factories registered.
 *
 * Handles configuration initialization internally (idempotent) unless
 * skipConfigSetup is true. Does NOT call initialize() — the caller
 * controls when async services start.
 */
export async function createDomainContainer(
  options?: DomainContainerOptions
): Promise<AppContainerInterface> {
  if (!options?.skipConfigSetup) {
    const { isConfigurationInitialized } = await import("../domain/configuration");
    if (!isConfigurationInitialized()) {
      const { setupConfiguration } = await import("../config-setup");
      await setupConfiguration();
    }
  }

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

  // Default ClientCapabilityRegistry is the no-op implementation. Entry
  // points that attach an MCP host (e.g., the MCP server) override this
  // with a per-connection-aware registry after container creation.
  container.register("clientCapabilityRegistry", () => new NoopClientCapabilityRegistry());

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
