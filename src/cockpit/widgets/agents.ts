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
import type { SessionProviderInterface, SessionRecord } from "../../domain/session/types";
import { SessionStatus } from "../../domain/session/types";
import { deriveSessionLiveness } from "../../domain/session/types";
import { formatTaskIdForDisplay } from "../../domain/tasks/task-id-utils";

/**
 * Minimal interface for task title look-up. The agents widget only needs
 * `getTask()` — a subset of `TaskServiceInterface` — keeping the coupling
 * thin and the test doubles trivial.
 */
export interface TaskProviderLike {
  getTask(taskId: string): Promise<{ title: string } | null>;
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
}

/** Terminal session statuses that should be filtered out */
const TERMINAL_STATUSES: Set<SessionStatus> = new Set([SessionStatus.MERGED, SessionStatus.CLOSED]);

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
  return {
    id: "agents",
    title: "Agents",
    updateMode: { type: "polling", intervalMs: 5000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const provider = await getProvider();
        const records = await provider.listSessions();

        const filtered = records.filter((r) => {
          // Filter terminal statuses
          if (r.status && TERMINAL_STATUSES.has(r.status)) return false;
          // Filter orphaned liveness
          const liveness = deriveSessionLiveness(r);
          if (liveness === "orphaned") return false;
          return true;
        });

        // Batch-fetch task titles for all unique non-null taskIds in one pass.
        // Using Promise.all avoids sequential awaits (no client-side waterfall).
        const taskTitleMap = new Map<string, string>();
        if (getTaskProvider) {
          try {
            const taskProvider = await Promise.race([
              getTaskProvider(),
              new Promise<TaskProviderLike>((_resolve, reject) =>
                setTimeout(() => reject(new Error("Task provider init timeout (5s)")), 5000)
              ),
            ]);
            const uniqueTaskIds = [
              ...new Set(filtered.map((r) => r.taskId).filter((id): id is string => id != null)),
            ];
            const results = await Promise.all(
              uniqueTaskIds.map(async (rawId) => {
                const displayId = formatTaskIdForDisplay(rawId);
                const task = await taskProvider.getTask(displayId);
                return { displayId, title: task?.title ?? null };
              })
            );
            for (const { displayId, title } of results) {
              if (title != null) {
                taskTitleMap.set(displayId, title);
              }
            }
          } catch {
            // Task provider failure is non-fatal — rows degrade to taskTitle: null.
          }
        }

        const agents: AgentRow[] = filtered.map((r) => {
          const displayTaskId = r.taskId ? formatTaskIdForDisplay(r.taskId) : null;
          const taskTitle = displayTaskId ? (taskTitleMap.get(displayTaskId) ?? null) : null;
          return toAgentRow(r, taskTitle);
        });

        const payload: AgentsPayload = { agents };
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
// Uses a lazily-initialised PersistenceService singleton so the cockpit
// server can register this without a DI container.  The provider is
// created once on first fetch(); subsequent calls reuse the cached instance.
//
// The `new PersistenceService() + .initialize() + .getProvider()` pattern
// here mirrors the canonical persistence-bootstrap in
// `src/composition/cli.ts:31-32` and `src/hooks/post-commit.ts:98-105`. The
// cockpit is a standalone Express server with no tsyringe container, so
// constructing a singleton inline is the established pattern, not a
// deviation. Switching to a shared DI container is a separate concern
// (cockpit/DI integration RFC).
// ---------------------------------------------------------------------------

let _cachedProvider: SessionProviderInterface | null = null;

async function defaultProviderFactory(): Promise<SessionProviderInterface> {
  if (_cachedProvider) return _cachedProvider;

  const { PersistenceService } = await import("../../domain/persistence/service");
  const { createSessionProvider } = await import("../../domain/session/session-db-adapter");

  const svc = new PersistenceService();
  await svc.initialize();
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
// Default task provider — lazy singleton mirroring defaultProviderFactory.
//
// Uses createConfiguredTaskService (the same path the CLI uses) so the widget
// benefits from multi-backend task resolution (mt# Minsky DB + gh# GitHub).
// A separate PersistenceService instance is constructed here to keep the
// session-provider singleton and the task-provider singleton independent;
// both share the same underlying DB URL, so there is no duplication of
// authoritative state.
// ---------------------------------------------------------------------------

let _cachedTaskProvider: TaskProviderLike | null = null;

async function _defaultTaskProviderFactory(): Promise<TaskProviderLike> {
  if (_cachedTaskProvider) return _cachedTaskProvider;

  const { PersistenceService } = await import("../../domain/persistence/service");
  const { createConfiguredTaskService } = await import("../../domain/tasks/taskService");

  const svc = new PersistenceService();
  await svc.initialize();
  const persistenceProvider = svc.getProvider();

  // Resolve workspace path — same strategy as src/composition/cli.ts.
  // The cockpit server is always started from the repo root, so process.cwd()
  // is a reliable workspace root without needing import.meta.url resolution.
  const workspacePath = process.cwd();

  const taskService = await createConfiguredTaskService({
    workspacePath,
    persistenceProvider,
  });

  _cachedTaskProvider = taskService;
  return _cachedTaskProvider;
}

/** Default agents widget — ready to drop into WIDGET_REGISTRY.
 *
 * Task-title enrichment (defaultTaskProviderFactory) is disabled: the second
 * PersistenceService instance deadlocks the DB connection pool when both
 * providers init concurrently. Fix tracked as a follow-up — the factory needs
 * to share the same PersistenceService instance as the session provider, or
 * use a connection-pool-aware init. Until then, agents show without task
 * titles (branch/sessionId fallback).
 */
export const agentsWidget: WidgetModule = createAgentsWidget(defaultProviderFactory);
