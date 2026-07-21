/**
 * Task Command Registry Setup
 *
 * Lazy initialization to avoid circular dependencies.
 */
import { TaskCommandRegistry } from "./base-task-command";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { DrizzleAskRepository } from "@minsky/domain/ask/repository";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";
import { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";

let registry: TaskCommandRegistry | null = null;

// Lazy registry setup function
export function setupTaskCommandRegistry(container?: AppContainerInterface) {
  if (!registry) {
    const newRegistry = new TaskCommandRegistry();

    // Import and register commands only when needed
    const commands = createAllTaskCommands(container);
    commands.forEach((command) => {
      newRegistry.register(command);
    });
    registry = newRegistry;
  }

  return registry;
}

// Factory function that creates commands when called
export function createAllTaskCommands(container?: AppContainerInterface) {
  const getPersistenceProvider = () => {
    if (!container?.has("persistence")) {
      throw new Error(
        "Persistence provider not available. Ensure the DI container is initialized."
      );
    }
    return container.get("persistence");
  };
  const getSessionProvider = async () => {
    if (!container?.has("sessionProvider")) {
      throw new Error("Session provider not available. Ensure the DI container is initialized.");
    }
    return container.get("sessionProvider");
  };
  // Optional (non-throwing) session provider for commands that treat session data as best-effort
  const getOptionalSessionProvider = () => {
    if (!container?.has("sessionProvider")) return undefined;
    return container.get("sessionProvider");
  };
  const getTaskGraphService = () => {
    if (!container?.has("taskGraphService")) {
      throw new Error("TaskGraphService not available. Ensure the DI container is initialized.");
    }
    return container.get("taskGraphService");
  };
  const getTaskRoutingService = () => {
    if (!container?.has("taskRoutingService")) {
      throw new Error("TaskRoutingService not available. Ensure the DI container is initialized.");
    }
    return container.get("taskRoutingService");
  };
  const getTaskService = () => {
    if (!container?.has("taskService")) {
      throw new Error("TaskService not available. Ensure the DI container is initialized.");
    }
    return container.get("taskService");
  };
  // Optional AskRepository factory — best-effort, returns null when unavailable
  const getAskRepository = async () => {
    if (!container?.has("persistence")) return null;
    try {
      const provider = container.get("persistence") as SqlCapablePersistenceProvider;
      if (!provider.getDatabaseConnection) return null;
      const db = await provider.getDatabaseConnection();
      if (!db) return null;
      return new DrizzleAskRepository(db);
    } catch (err: unknown) {
      log.debug("[tasks] Could not initialize AskRepository for BLOCKED subtype enrichment", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  // Optional SubagentDispatchTracker factory — best-effort, returns null when unavailable (mt#1737)
  //
  // mt#2945: retries on every call while no attempt is in flight, instead of
  // giving up permanently after the FIRST failed attempt. The original
  // one-shot design (`_trackerInitAttempted` latched true before the async
  // init even started) meant a single transient Postgres hiccup — exactly
  // the kind that can happen right after a server reload while the
  // connection pool is still warming up — wedged the tracker "unavailable"
  // for the rest of the process's life, with tasks.dispatch-recover
  // reporting "Subagent dispatch tracker unavailable" forever after. This is
  // the sibling symptom to mt#2945's session_pr_* null-deref: both trace back
  // to a reload-time persistence hiccup that the old code treated as
  // permanent instead of retriable.
  let _cachedTracker: SubagentDispatchTracker | null = null;
  let _trackerInitInFlight = false;
  const getTracker = (): SubagentDispatchTracker | null => {
    if (_cachedTracker) return _cachedTracker;
    if (_trackerInitInFlight) return null; // an attempt is already in flight
    if (!container?.has("persistence")) return null;
    let provider: SqlCapablePersistenceProvider;
    try {
      provider = container.get("persistence") as SqlCapablePersistenceProvider;
    } catch (err: unknown) {
      log.debug("[tasks] Could not initialize SubagentDispatchTracker (sync error)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!provider.getDatabaseConnection) return null;
    _trackerInitInFlight = true;
    // Tracker requires a PostgresJsDatabase. We kick off async init here;
    // if it resolves before the next call, the tracker becomes available.
    // A failed attempt resets `_trackerInitInFlight` in `finally` so the NEXT
    // getTracker() call retries rather than staying permanently unavailable.
    (async () => {
      try {
        const db = await provider.getDatabaseConnection();
        if (db) {
          _cachedTracker = new SubagentDispatchTracker(
            db as import("drizzle-orm/postgres-js").PostgresJsDatabase
          );
        }
      } catch (err: unknown) {
        log.debug("[tasks] Could not initialize SubagentDispatchTracker", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        _trackerInitInFlight = false;
      }
    })();
    return null; // Async init; this call (and any concurrent ones) return null
  };
  // Import command creation functions locally to avoid top-level circular imports
  const { createTasksStatusGetCommand, createTasksStatusSetCommand } = require("./status-commands");
  const { createTasksSpecCommand } = require("./spec-command");
  const { createTasksSpecFreshnessCommand } = require("./spec-freshness-command");
  const {
    createTasksListCommand,
    createTasksGetCommand,
    createTasksCreateCommand,
    createTasksDeleteCommand,
  } = require("./crud-commands");
  const { createTasksEditCommand } = require("./edit-commands");
  const { createTasksBulkEditCommand } = require("./bulk-edit-command");
  const { createTasksMigrateBackendCommand } = require("./migrate-backend-command");
  const { TasksSimilarCommand, TasksSearchCommand } = require("./similarity-commands");
  const { TasksIndexEmbeddingsCommand } = require("./index-embeddings-command");
  const { TasksEmbeddingsStatusCommand } = require("./embeddings-status-command");
  const { TasksEmbeddingsRepairCommand } = require("./embeddings-repair-command");
  const {
    createTasksDepsAddCommand,
    createTasksDepsRmCommand,
    createTasksDepsListCommand,
    createTasksChildrenCommand,
    createTasksParentCommand,
  } = require("./deps-commands");
  const { createTasksReparentCommand } = require("./reparent-command");
  const {
    createTasksDepsTreeCommand,
    createTasksDepsGraphCommand,
  } = require("./deps-visualization-commands");
  const { createTasksAvailableCommand, createTasksRouteCommand } = require("./routing-commands");
  const { createTasksDispatchCommand } = require("./dispatch-command");
  const { createTasksDispatchRecoverCommand } = require("./dispatch-recover-command");
  const { createTasksOrchestrateCommand } = require("./orchestrate-command");
  const {
    createTasksDecomposeCommand,
    createTasksEstimateCommand,
    createTasksAnalyzeCommand,
  } = require("./context-commands");
  const { createTasksClaimsListCommand } = require("./claims-command");

  return [
    createTasksStatusGetCommand(getPersistenceProvider, getTaskService),
    createTasksStatusSetCommand(getPersistenceProvider, getTaskService, getTaskGraphService),
    createTasksSpecCommand(getPersistenceProvider, getTaskService),
    createTasksSpecFreshnessCommand(getPersistenceProvider, getTaskService),
    createTasksListCommand(
      getPersistenceProvider,
      getTaskGraphService,
      getTaskService,
      getAskRepository
    ),
    createTasksGetCommand(
      getPersistenceProvider,
      getTaskGraphService,
      getTaskService,
      getOptionalSessionProvider,
      getAskRepository
    ),
    createTasksCreateCommand(getPersistenceProvider, getTaskGraphService, getTaskService),
    createTasksEditCommand(getPersistenceProvider, getTaskService),
    createTasksBulkEditCommand(getPersistenceProvider, getTaskService),
    createTasksDeleteCommand(getPersistenceProvider, getTaskGraphService, getTaskService),
    new TasksSimilarCommand(getPersistenceProvider, getTaskService),
    new TasksSearchCommand(getPersistenceProvider, getTaskService),
    new TasksIndexEmbeddingsCommand(getPersistenceProvider, getTaskService),
    new TasksEmbeddingsStatusCommand(),
    new TasksEmbeddingsRepairCommand(),
    createTasksMigrateBackendCommand(),
    // Dependency management commands
    createTasksDepsAddCommand(getTaskGraphService),
    createTasksDepsRmCommand(getTaskGraphService),
    createTasksDepsListCommand(getTaskGraphService),
    createTasksDepsTreeCommand(getTaskGraphService, getTaskService),
    createTasksDepsGraphCommand(getTaskGraphService, getTaskService),
    // Parent-child (subtask) commands
    createTasksChildrenCommand(getTaskGraphService),
    createTasksParentCommand(getTaskGraphService),
    createTasksReparentCommand(getTaskGraphService),
    // Routing commands
    createTasksAvailableCommand(getPersistenceProvider, getTaskRoutingService, getTaskService),
    createTasksRouteCommand(getPersistenceProvider, getTaskRoutingService),
    // Dispatch (subtask + session + prompt in one call)
    createTasksDispatchCommand(
      getPersistenceProvider,
      getSessionProvider,
      getTaskGraphService,
      getTaskService,
      getTracker
    ),
    // Dispatch-recover (mt#2831): server-side detect/classify/prepare for a died/stalled dispatch
    createTasksDispatchRecoverCommand(getSessionProvider, getTaskService, getTracker),
    // Orchestrate (find dispatchable subtasks for a parent)
    createTasksOrchestrateCommand(getTaskGraphService, getTaskService),
    // Context commands (decompose, estimate, analyze)
    createTasksDecomposeCommand(getTaskGraphService, getTaskService),
    createTasksEstimateCommand(getTaskGraphService, getTaskService),
    createTasksAnalyzeCommand(getTaskGraphService, getTaskService),
    // Presence/claim commands (mt#2562)
    createTasksClaimsListCommand(getPersistenceProvider),
  ];
}
