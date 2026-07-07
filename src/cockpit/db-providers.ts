/**
 * Cockpit-wide lazy-cached persistence getters (mt#2615 — extracted from
 * server.ts).
 *
 * server.ts previously duplicated ~150-180 lines across six near-identical
 * lazy-cached getters (lines 149/183/623/647/689/802 of the pre-split file),
 * each repeating the same `getSharedPersistenceService -> getProvider ->
 * probe capability -> cache` shape. This module centralizes the two REAL
 * shared shapes:
 *
 *   - `getCachedPersistenceProvider()` — the common `getSharedPersistenceService()`
 *     bootstrap step (3 duplicated lines), used by getServerTaskService,
 *     getServerTaskDetailDeps, and getServerSessionProvider — none of which
 *     need a raw db handle, just the provider itself.
 *   - `createCachedSqlDbGetter()` — a factory for the `getDatabaseConnection`
 *     probe-and-cache shape, used by getContextInspectorDb and (indirectly)
 *     getServerAskRepository / getServerTaskDetailDeps.
 *
 * NOT all six getters collapse into calling the exact same function:
 * getServerSseBroker (routes/events.ts) needs `getListenCapableSqlConnection`
 * — a different capability entirely — so it is NOT built on
 * `createCachedSqlDbGetter` and lives in its own module.
 *
 * Cache-negative behavior is preserved EXACTLY per callsite (a real,
 * pre-existing behavioral difference, not an oversight):
 *   - `getContextInspectorDb` permanently caches a `null` after the FIRST
 *     failed probe (`cacheNegative: true`).
 *   - `getServerAskRepository` / `getServerTaskDetailDeps` retry the probe
 *     on EVERY call until the first success (`cacheNegative: false`).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { SessionProviderInterface } from "@minsky/domain/session/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// getCachedPersistenceProvider — shared bootstrap step
// ---------------------------------------------------------------------------

/**
 * Fetch the cockpit-wide PersistenceProvider.
 *
 * `getSharedPersistenceService()` (shared-persistence.ts) is ALREADY a
 * module-level singleton (it caches its own `_instance`), so this adds no
 * additional caching of its own — it only removes the 3-line
 * `getSharedPersistenceService -> getProvider` bootstrap that was duplicated
 * across getServerTaskService / getServerTaskDetailDeps / getServerSessionProvider.
 */
export async function getCachedPersistenceProvider() {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  return svc.getProvider();
}

// ---------------------------------------------------------------------------
// createCachedSqlDbGetter — shared lazy-cached SQL-db-handle factory
// ---------------------------------------------------------------------------

/**
 * Build a lazy-cached SQL-capable-provider database getter.
 *
 * @param options.cacheNegative When `true`, permanently cache a `null`
 *   result after the FIRST failed probe — later calls never re-check the
 *   provider (matches `getContextInspectorDb`'s exact pre-split behavior).
 *   When `false`, a failed probe is NOT cached — every call retries until
 *   the first success (matches the other callers' exact pre-split behavior).
 *   This is a real, intentional difference between the callers today; this
 *   option preserves it exactly rather than silently unifying it.
 */
export function createCachedSqlDbGetter(options: {
  cacheNegative: boolean;
}): () => Promise<PostgresJsDatabase | null> {
  let cachedDb: PostgresJsDatabase | null = null;
  let probedAndFailed = false;

  return async function getCachedSqlDb(): Promise<PostgresJsDatabase | null> {
    if (cachedDb) return cachedDb;
    if (options.cacheNegative && probedAndFailed) return null;
    try {
      const provider = await getCachedPersistenceProvider();
      if (
        !("getDatabaseConnection" in provider) ||
        typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !==
          "function"
      ) {
        probedAndFailed = true;
        return null;
      }
      const sqlProvider = provider as {
        getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
      };
      const db = await sqlProvider.getDatabaseConnection();
      if (!db) {
        probedAndFailed = true;
        return null;
      }
      cachedDb = db;
      return cachedDb;
    } catch {
      probedAndFailed = true;
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Context-inspector SQL connection — lazy-cached singleton (mt#2023).
// Uses the cockpit-wide PersistenceService singleton (shared-persistence.ts).
// Returns null when the provider is non-SQL (the endpoint returns 503).
// cacheNegative: true — a failed probe is cached PERMANENTLY (exact
// pre-split behavior of `_cachedContextInspectorDbProbed`).
// ---------------------------------------------------------------------------

export const getContextInspectorDb = createCachedSqlDbGetter({ cacheNegative: true });

// ---------------------------------------------------------------------------
// AskRepository lazy init — uses cockpit-wide PersistenceService singleton.
// cacheNegative: false — a failed probe retries on every call (exact
// pre-split behavior: `_cachedServerAskRepo` only ever caches a SUCCESSFUL
// repository instance).
// ---------------------------------------------------------------------------

const getAskDb = createCachedSqlDbGetter({ cacheNegative: false });
let _cachedServerAskRepo: AskRepository | null = null;

export async function getServerAskRepository(): Promise<AskRepository | null> {
  if (_cachedServerAskRepo) return _cachedServerAskRepo;
  try {
    const db = await getAskDb();
    if (!db) return null;
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
    _cachedServerAskRepo = new DrizzleAskRepository(db);
    return _cachedServerAskRepo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task service lazy init — uses cockpit-wide PersistenceService singleton.
// ---------------------------------------------------------------------------

interface TaskDetailDeps {
  taskService: TaskServiceInterface;
  taskGraphService: TaskGraphService;
}

let _cachedTaskService: TaskServiceInterface | null = null;
let _cachedTaskDetailDeps: TaskDetailDeps | null = null;

export async function getServerTaskService(): Promise<TaskServiceInterface | null> {
  if (_cachedTaskService) return _cachedTaskService;
  try {
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const provider = await getCachedPersistenceProvider();
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    _cachedTaskService = taskService;
    return _cachedTaskService;
  } catch {
    return null;
  }
}

/**
 * Lazy-cached task detail deps (TaskService + TaskGraphService).
 * Uses cockpit-wide PersistenceService singleton. Retries on every call
 * until first success (cacheNegative: false semantics, same as
 * getServerAskRepository) — `_cachedTaskDetailDeps` only ever caches a
 * SUCCESSFUL result.
 */
export async function getServerTaskDetailDeps(): Promise<TaskDetailDeps | null> {
  if (_cachedTaskDetailDeps) return _cachedTaskDetailDeps;
  try {
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const { TaskGraphService } = await import("@minsky/domain/tasks/task-graph-service");

    const provider = await getCachedPersistenceProvider();

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });

    const sqlProvider = provider as SqlCapablePersistenceProvider;
    const db = await sqlProvider.getDatabaseConnection?.();
    if (!db) return null;

    const taskGraphService = new TaskGraphService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    _cachedTaskDetailDeps = { taskService, taskGraphService };
    return _cachedTaskDetailDeps;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session provider lazy init — uses cockpit-wide PersistenceService singleton
// (mt#1919). Mirrors the agents-widget defaultProviderFactory; kept separate
// so the endpoint and the widget caches stay independently invalidatable
// (mt#2362 touches the widget's cache).
// ---------------------------------------------------------------------------

let _cachedServerSessionProvider: SessionProviderInterface | null = null;

export async function getServerSessionProvider(): Promise<SessionProviderInterface | null> {
  if (_cachedServerSessionProvider) return _cachedServerSessionProvider;
  try {
    const { createSessionProvider } = await import(
      "@minsky/domain/session/drizzle-session-repository"
    );
    const persistenceProvider = await getCachedPersistenceProvider();
    const provider = await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => persistenceProvider,
      },
    });
    _cachedServerSessionProvider = provider;
    return provider;
  } catch {
    return null;
  }
}
