/**
 * Agents widget (mt#1145)
 *
 * Live view of SessionRecord entries: liveness, task binding, PR state.
 * Filters out orphaned sessions and sessions in terminal statuses (MERGED, CLOSED).
 *
 * The widget is constructed via createAgentsWidget(), which accepts a
 * getSessionProvider async factory and an optional getTaskProvider async factory
 * so the cockpit server can inject the real persistence providers while tests
 * inject lightweight doubles.
 *
 * The default export `agentsWidget` uses lazy PersistenceService singletons
 * for production use (no DI container needed).
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session/types";
import { SessionStatus } from "@minsky/domain/session/types";
import { deriveSessionLiveness } from "@minsky/domain/session/types";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";

/**
 * Minimal interface for task title look-up. Keeps coupling thin and test
 * doubles trivial.
 *
 * - `getTask(id)` — single look-up; `id` is in display form (e.g. `"mt#123"`).
 * - `getTasks(ids)` — optional batch look-up. IDs are in display form. Returns
 *   only found tasks (missing IDs are omitted, not returned as null). Returned
 *   `id` values must match the input display-form IDs.
 */
export interface TaskProviderLike {
  getTask(taskId: string): Promise<{ title: string } | null>;
  getTasks?(ids: string[]): Promise<{ id: string; title: string }[]>;
}

/** Shape of a single agent row emitted in the payload */
export interface AgentRow {
  sessionId: string;
  title: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned";
  taskId: string | null;
  /** Human-readable task title sourced from the task backend; null when taskId
   *  is absent or the task could not be resolved. */
  taskTitle: string | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
  agentId: string | null;
}

/** Full payload returned by this widget when state === "ok" */
export interface AgentsPayload {
  agents: AgentRow[];
  totalCount: number;
}

/** Terminal session statuses that should be filtered out */
const TERMINAL_STATUSES: Set<SessionStatus> = new Set([SessionStatus.MERGED, SessionStatus.CLOSED]);

const DEFAULT_TASK_TITLE_TTL_MS = 60_000;

class TaskTitleCache {
  private cache = new Map<string, string>();
  private attempted = new Set<string>();
  private lastPopulatedAt = 0;
  private populatePromise: Promise<void> | null = null;

  constructor(
    private readonly getTaskProvider: () => Promise<TaskProviderLike>,
    private readonly ttlMs: number = DEFAULT_TASK_TITLE_TTL_MS
  ) {}

  private isStale(): boolean {
    return Date.now() - this.lastPopulatedAt > this.ttlMs;
  }

  async getTitles(taskIds: string[]): Promise<Map<string, string>> {
    if (!this.isStale() && this.cache.size > 0) {
      const result = new Map<string, string>();
      const missing: string[] = [];
      for (const id of taskIds) {
        const title = this.cache.get(id);
        if (title != null) {
          result.set(id, title);
        } else if (!this.attempted.has(id)) {
          missing.push(id);
        }
      }

      if (missing.length > 0) {
        await this.fetchAndCache(missing);
        for (const id of missing) {
          const title = this.cache.get(id);
          if (title != null) result.set(id, title);
        }
      }

      return result;
    }

    if (this.populatePromise) {
      await this.populatePromise;
      const result = new Map<string, string>();
      for (const id of taskIds) {
        const title = this.cache.get(id);
        if (title != null) result.set(id, title);
      }
      return result;
    }

    this.populatePromise = this.populate(taskIds);
    try {
      await this.populatePromise;
    } finally {
      this.populatePromise = null;
    }

    const result = new Map<string, string>();
    for (const id of taskIds) {
      const title = this.cache.get(id);
      if (title != null) result.set(id, title);
    }
    return result;
  }

  private async fetchAndCache(ids: string[]): Promise<void> {
    try {
      const taskProvider = await this.getTaskProvider();
      if (typeof taskProvider.getTasks === "function") {
        const tasks = await taskProvider.getTasks(ids);
        for (const task of tasks) {
          this.cache.set(task.id, task.title);
        }
      } else {
        const results = await Promise.all(
          ids.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null };
          })
        );
        for (const { displayId, title } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
          }
        }
      }
      for (const id of ids) {
        this.attempted.add(id);
      }
    } catch {
      // Non-fatal — missing IDs stay uncached
    }
  }

  private async populate(taskIds: string[]): Promise<void> {
    try {
      const taskProvider = await Promise.race([
        this.getTaskProvider(),
        new Promise<TaskProviderLike>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Task provider init timeout (5s)")), 5000)
        ),
      ]);

      if (typeof taskProvider.getTasks === "function") {
        const tasks = await taskProvider.getTasks(taskIds);
        for (const task of tasks) {
          this.cache.set(task.id, task.title);
        }
      } else {
        const results = await Promise.all(
          taskIds.map(async (displayId) => {
            const task = await taskProvider.getTask(displayId);
            return { displayId, title: task?.title ?? null };
          })
        );
        for (const { displayId, title } of results) {
          if (title != null) {
            this.cache.set(displayId, title);
          }
        }
      }
      this.lastPopulatedAt = Date.now();
      for (const id of taskIds) {
        this.attempted.add(id);
      }
    } catch {
      // Task provider failure is non-fatal — rows degrade to taskTitle: null.
    }
  }
}

/**
 * Map a SessionRecord to an AgentRow.
 * Derives liveness via the domain function; leaves agentId as null
 * until mt#1078 populates it.
 *
 * @param record  The session record to map.
 * @param taskTitle  Pre-fetched task title (or null when unavailable).
 */
function toAgentRow(record: SessionRecord, taskTitle: string | null): AgentRow {
  const liveness = deriveSessionLiveness(record);

  // Title precedence: prefer the human-meaningful git branch when present,
  // otherwise fall back to the full sessionId. A truncated 8-char prefix
  // risks collisions and is misleading for a primary identifier (PR #1030 R1
  // reviewer finding).
  const title = record.branch ?? record.sessionId;

  // Storage may hold task IDs in either plain ("123") or qualified ("mt#123")
  // form because `SessionDbAdapter.addTaskToSession()` normalizes to qualified
  // before persisting. Delegate to the shared display formatter so we don't
  // double-prefix already-qualified IDs (PR #1030 R2 reviewer finding).
  const taskId = record.taskId ? formatTaskIdForDisplay(record.taskId) : null;

  let prNumber: number | null = null;
  let prStatus: string | null = null;
  if (record.pullRequest) {
    prNumber = record.pullRequest.number;
    prStatus = record.pullRequest.state;
  }

  const lastActivityAt = record.lastActivityAt ?? record.createdAt;

  return {
    sessionId: record.sessionId,
    title,
    liveness,
    taskId,
    taskTitle,
    prNumber,
    prStatus,
    lastActivityAt,
    agentId: record.agentId ?? null,
  };
}

/**
 * Factory: returns a WidgetModule backed by the given session provider factory.
 *
 * @param getProvider  Async factory that returns a SessionProviderInterface.
 *   Called on each fetch() so callers can lazily initialise the provider.
 *   If the call throws, fetch() catches and returns a degraded state.
 *
 * @param getTaskProvider  Optional async factory that returns a TaskProviderLike.
 *   When provided, task titles are looked up in a single parallel batch for all
 *   unique non-null taskIds in the current session list. When absent or when the
 *   factory throws, taskTitle fields are null (graceful degradation).
 *
 * @example
 *   // Production use (cockpit default):
 *   export const agentsWidget = createAgentsWidget(defaultProviderFactory, defaultTaskProviderFactory);
 *
 *   // Test use (session provider only, no task enrichment):
 *   const widget = createAgentsWidget(async () => mockProvider);
 *
 *   // Test use (with task enrichment):
 *   const widget = createAgentsWidget(async () => mockProvider, async () => mockTaskProvider);
 */
export function createAgentsWidget(
  getProvider: () => Promise<SessionProviderInterface>,
  getTaskProvider?: () => Promise<TaskProviderLike>
): WidgetModule {
  const titleCache = getTaskProvider ? new TaskTitleCache(getTaskProvider) : null;

  return {
    id: "agents",
    title: "Agents",
    updateMode: { type: "polling", intervalMs: 5000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const provider = await getProvider();

        const limit = ctx.query?.limit ? parseInt(ctx.query.limit, 10) : undefined;
        const offset = ctx.query?.offset ? parseInt(ctx.query.offset, 10) : undefined;
        const isPaginated = limit != null && !isNaN(limit);

        // Filter terminal statuses at DB level; orphaned liveness is derived
        // in JS (no DB column) so it stays as a post-fetch filter.
        const allRecords = await provider.listSessions({
          statusNotIn: [...TERMINAL_STATUSES],
        });

        const filtered = allRecords.filter((r) => {
          const liveness = deriveSessionLiveness(r);
          if (liveness === "orphaned") return false;
          return true;
        });

        const totalCount = filtered.length;

        const page = isPaginated ? filtered.slice(offset ?? 0, (offset ?? 0) + limit) : filtered;

        // Batch-fetch task titles — uses TTL cache to avoid re-querying on each poll.
        const taskTitleMap = new Map<string, string>();
        if (titleCache) {
          const uniqueTaskIds = Array.from(
            new Set(
              page
                .map((r) => r.taskId)
                .filter((id): id is string => id != null)
                .map(formatTaskIdForDisplay)
            )
          );
          if (uniqueTaskIds.length > 0) {
            const titles = await titleCache.getTitles(uniqueTaskIds);
            for (const [id, title] of titles) {
              taskTitleMap.set(id, title);
            }
          }
        }

        const agents: AgentRow[] = page.map((r) => {
          const displayTaskId = r.taskId ? formatTaskIdForDisplay(r.taskId) : null;
          const taskTitle = displayTaskId ? (taskTitleMap.get(displayTaskId) ?? null) : null;
          return toAgentRow(r, taskTitle);
        });

        const payload: AgentsPayload = { agents, totalCount };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `session_list error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Uses the cockpit-wide PersistenceService singleton (src/cockpit/shared-persistence.ts)
// so all widgets share one connection pool. The provider is created once on first
// fetch(); subsequent calls reuse the cached instance.
// ---------------------------------------------------------------------------

import { getSharedPersistenceService } from "../shared-persistence";

let _cachedProvider: SessionProviderInterface | null = null;

async function defaultProviderFactory(): Promise<SessionProviderInterface> {
  if (_cachedProvider) return _cachedProvider;

  const { createSessionProvider } = await import(
    "@minsky/domain/session/drizzle-session-repository"
  );

  const svc = await getSharedPersistenceService();
  const provider = await createSessionProvider(undefined, {
    persistenceService: {
      isInitialized: () => true,
      getProvider: () => svc.getProvider(),
    },
  });
  _cachedProvider = provider;
  return provider;
}

// ---------------------------------------------------------------------------
// Default task provider — lazy singleton sharing PersistenceService with
// the session provider above (mt#2079).
//
// Uses createConfiguredTaskService (the same path the CLI uses) so the widget
// benefits from multi-backend task resolution (mt# Minsky DB + gh# GitHub).
// ---------------------------------------------------------------------------

let _cachedTaskProvider: TaskProviderLike | null = null;

async function defaultTaskProviderFactory(): Promise<TaskProviderLike> {
  if (_cachedTaskProvider) return _cachedTaskProvider;

  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  const svc = await getSharedPersistenceService();
  const persistenceProvider = svc.getProvider();

  const workspacePath = process.cwd();

  const taskService = await createConfiguredTaskService({
    workspacePath,
    persistenceProvider,
  });

  _cachedTaskProvider = taskService;
  return _cachedTaskProvider;
}

/** Default agents widget — ready to drop into WIDGET_REGISTRY */
export const agentsWidget: WidgetModule = createAgentsWidget(
  defaultProviderFactory,
  defaultTaskProviderFactory
);
