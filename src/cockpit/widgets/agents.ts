/**
 * Agents widget (mt#1145)
 *
 * Live view of SessionRecord entries: liveness, task binding, PR state.
 * Filters out orphaned sessions and sessions in terminal statuses (MERGED, CLOSED).
 *
 * The widget is constructed via createAgentsWidget(), which accepts a
 * getSessionProvider async factory so the cockpit server can inject the
 * real persistence provider while tests inject a lightweight double.
 *
 * The default export `agentsWidget` uses a lazy PersistenceService singleton
 * for production use (no DI container needed).
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { SessionProviderInterface, SessionRecord } from "../../domain/session/types";
import { SessionStatus } from "../../domain/session/types";
import { deriveSessionLiveness } from "../../domain/session/types";

/** Shape of a single agent row emitted in the payload */
export interface AgentRow {
  sessionId: string;
  title: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned";
  taskId: string | null;
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
 */
function toAgentRow(record: SessionRecord): AgentRow {
  const liveness = deriveSessionLiveness(record);

  const shortId = record.sessionId.slice(0, 8);
  const title = record.sessionId.length > 8 ? `session ${shortId}` : record.sessionId;

  const taskId = record.taskId ? `mt#${record.taskId}` : null;

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
 * @example
 *   // Production use (cockpit default):
 *   export const agentsWidget = createAgentsWidget(defaultProviderFactory);
 *
 *   // Test use:
 *   const widget = createAgentsWidget(async () => mockProvider);
 */
export function createAgentsWidget(
  getProvider: () => Promise<SessionProviderInterface>
): WidgetModule {
  return {
    id: "agents",
    title: "Agents",
    updateMode: { type: "polling", intervalMs: 5000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const provider = await getProvider();
        const records = await provider.listSessions();

        const agents: AgentRow[] = records
          .filter((r) => {
            // Filter terminal statuses
            if (r.status && TERMINAL_STATUSES.has(r.status)) return false;
            // Filter orphaned liveness
            const liveness = deriveSessionLiveness(r);
            if (liveness === "orphaned") return false;
            return true;
          })
          .map(toAgentRow);

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
// ---------------------------------------------------------------------------

let _cachedProvider: SessionProviderInterface | null = null;

async function defaultProviderFactory(): Promise<SessionProviderInterface> {
  if (_cachedProvider) return _cachedProvider;

  const { PersistenceService } = await import("../../domain/persistence/service");
  const { createSessionProvider } = await import("../../domain/session/session-db-adapter");

  const svc = new PersistenceService();
  await svc.initialize();
  const provider = await createSessionProvider(undefined, svc.getProvider());
  _cachedProvider = provider;
  return provider;
}

/** Default agents widget — ready to drop into WIDGET_REGISTRY */
export const agentsWidget: WidgetModule = createAgentsWidget(defaultProviderFactory);
