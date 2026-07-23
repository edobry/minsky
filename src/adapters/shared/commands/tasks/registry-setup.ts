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
  //
  // mt#3017: mt#2945 fixed the PERMANENT-latch symptom but left the
  // underlying race intact — `getTracker()` was still a SYNCHRONOUS function
  // that returned `null` immediately on the very first call after every
  // process restart (i.e. every deploy) and on every call that raced an
  // in-flight init, even though the DB connection was healthy and typically
  // resolved within milliseconds. A caller that only gets ONE synchronous
  // chance — `tasks.dispatch-recover`'s "Subagent dispatch tracker
  // unavailable" error, or `tasks.dispatch`'s Step 5 invocation-row write —
  // had no way to wait for that resolution. Confirmed live (mt#3017
  // investigation, 2026-07-22): immediately after a process restart
  // (`debug_systemInfo` `nodejs.uptime` in the hundreds of seconds),
  // `tasks.dispatch-recover` against a task with real dispatch history
  // (mt#3017 itself) succeeded once the tracker had warmed — the DB and the
  // write path were both healthy; the bug was purely the read-side timing
  // window between "process started" and "first caller happens to warm the
  // cache."
  //
  // This version memoizes the IN-FLIGHT PROMISE (not just a boolean flag) so
  // every caller during initialization AWAITS the SAME resolution instead of
  // racing a premature null return. Bounded by `TRACKER_INIT_TIMEOUT_MS` so a
  // genuinely-down DB still resolves to null promptly rather than hanging the
  // caller indefinitely — the SC3 degraded-response path in
  // `tasks.dispatch-recover` is what a caller falls back to when this timeout
  // is hit.
  const TRACKER_INIT_TIMEOUT_MS = 5000;
  let _cachedTracker: SubagentDispatchTracker | null = null;
  let _trackerInitPromise: Promise<SubagentDispatchTracker | null> | null = null;
  const getTracker = async (): Promise<SubagentDispatchTracker | null> => {
    if (_cachedTracker) return _cachedTracker;
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

    if (!_trackerInitPromise) {
      // Tracker requires a PostgresJsDatabase. Every caller that arrives
      // while this promise is in flight awaits the SAME resolution (they all
      // read the local `_trackerInitPromise` reference below), rather than
      // each independently kicking off — or short-circuiting past — their
      // own attempt. On failure the promise resets to null in `finally` so
      // the NEXT getTracker() call retries (mt#2945's contract, preserved).
      // On success `_cachedTracker` is set, so future calls short-circuit at
      // the top of this function before ever consulting the promise again.
      _trackerInitPromise = (async () => {
        try {
          const db = await provider.getDatabaseConnection();
          if (db) {
            _cachedTracker = new SubagentDispatchTracker(
              db as import("drizzle-orm/postgres-js").PostgresJsDatabase
            );
          }
          return _cachedTracker;
        } catch (err: unknown) {
          log.debug("[tasks] Could not initialize SubagentDispatchTracker", {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        } finally {
          _trackerInitPromise = null;
        }
      })();
    }

    const initPromise = _trackerInitPromise;
    // mt#3017 R1 BLOCKING #1: a HUNG connection attempt (neither resolves nor
    // rejects — e.g. a network partition with no socket-level timeout) never
    // reaches the inner promise's `finally`, so `_trackerInitPromise` would
    // otherwise stay pinned to that same stuck promise forever — every
    // subsequent call would keep racing the identical hang and always time
    // out to null, permanently defeating the retry contract even after the
    // DB recovers. On a timeout loss, clear the memoized promise (guarded by
    // a reference-equality check so a genuinely NEWER attempt, kicked off by
    // a concurrent caller between this race losing and this line running,
    // is never clobbered) so the NEXT call starts a fresh connection attempt
    // instead of rejoining the same permanently-hung one.
    const TIMEOUT_SENTINEL = Symbol("tracker-init-timeout");
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SENTINEL), TRACKER_INIT_TIMEOUT_MS);
    });
    const result = await Promise.race([initPromise, timeout]);
    if (result === TIMEOUT_SENTINEL) {
      if (_trackerInitPromise === initPromise) {
        _trackerInitPromise = null;
      }
      return null;
    }
    return result;
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
    // Dispatch-recover (mt#2831): server-side detect/classify/prepare for a died/stalled dispatch.
    // getPersistenceProvider (mt#3086) — builds the presence-claim liveness signal.
    createTasksDispatchRecoverCommand(
      getSessionProvider,
      getTaskService,
      getTracker,
      getPersistenceProvider
    ),
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
