/**
 * Attention widget server module (mt#1147)
 *
 * Replaces the AttentionStub placeholder. Queries the pending-asks cohort
 * from the Ask repository and surfaces the active window state.
 *
 * Architecture:
 *   - Server-side: queries AskRepository for suspended/routed asks that
 *     match the current open window. Falls back to all operator-routed
 *     suspended asks when no window is active.
 *   - Frontend: TanStack Query with 10s polling against this widget endpoint.
 *
 * The widget uses the same factory pattern as agents.ts:
 *   createAttentionWidget(getDepsFactory) — injectable for tests.
 *   attentionWidget — default production instance.
 *
 * Data contract: payload shape is AttentionPayload (defined below).
 * Frontend mirrors the shape in Attention.tsx — keep in sync.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";
import {
  pendingAsksForWindow,
  compareAskPriority,
} from "@minsky/domain/ask/pending-asks-for-window";
import { isTerminal } from "@minsky/domain/ask/state-machine";

// ---------------------------------------------------------------------------
// Public payload shapes — mirrored in Attention.tsx; keep in sync.
// ---------------------------------------------------------------------------

/** Serialisable Ask subset for the widget payload. */
export interface AttentionAsk {
  id: string;
  kind: Ask["kind"];
  state: Ask["state"];
  title: string;
  question: string;
  requestor: string;
  routingTarget?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  options?: Ask["options"];
  contextRefs?: Ask["contextRefs"];
  deadline?: string;
  createdAt: string;
  suspendedAt?: string;
  windowKey?: string;
  windowMissedCount: number;
  serviceStrategy?: Ask["serviceStrategy"];
  metadata: Record<string, unknown>;
}

/** Active window info — null when no window is currently open. */
export interface ActiveWindowInfo {
  windowKey: string;
  openedAt?: string;
  expectedCloseAt?: string;
}

/** Full payload returned when state === "ok". */
export interface AttentionPayload {
  /** Currently active service window, or null if no window is open. */
  activeWindow: ActiveWindowInfo | null;
  /** Pending asks in the active window cohort, priority-sorted. */
  cohort: AttentionAsk[];
  /** Total count of pending operator-routed asks (all windows). */
  totalPending: number;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function toAttentionAsk(ask: Ask): AttentionAsk {
  return {
    id: ask.id,
    kind: ask.kind,
    state: ask.state,
    title: ask.title,
    question: ask.question,
    requestor: ask.requestor,
    routingTarget: ask.routingTarget as string | undefined,
    parentTaskId: ask.parentTaskId,
    parentSessionId: ask.parentSessionId,
    options: ask.options,
    contextRefs: ask.contextRefs,
    deadline: ask.deadline,
    createdAt: ask.createdAt,
    suspendedAt: ask.suspendedAt,
    windowKey: ask.windowKey,
    windowMissedCount: ask.windowMissedCount ?? 0,
    serviceStrategy: ask.serviceStrategy,
    metadata: ask.metadata,
  };
}

/**
 * Fetch the pending operator-routed asks.
 *
 * Priority:
 *   1. If a windowKey is provided (active window), load cohort via
 *      `pendingAsksForWindow` — same query as the CLI sibling (mt#1491).
 *   2. Otherwise fall back to all `suspended` asks routed to "operator",
 *      sorted by priority.
 */
async function loadCohort(repo: AskRepository, windowKey: string | null): Promise<Ask[]> {
  const nowMs = Date.now();

  if (windowKey) {
    return pendingAsksForWindow(repo, windowKey, nowMs);
  }

  // Fallback: all suspended asks routed to operator (no active window)
  const suspended = await repo.listByState("suspended");
  const operatorAsks = suspended.filter(
    (a) => a.routingTarget === "operator" && !isTerminal(a.state)
  );
  operatorAsks.sort(compareAskPriority);
  return operatorAsks;
}

// ---------------------------------------------------------------------------
// Deps interface — injectable for tests
// ---------------------------------------------------------------------------

export interface AttentionDeps {
  repo: AskRepository;
  /** Currently open window key — null if no window is open. */
  activeWindowKey: string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Attention widget backed by the given deps factory.
 *
 * @param getDeps  Async factory returning AttentionDeps.
 *   Called on each fetch(). If it throws, fetch() returns degraded state.
 */
export function createAttentionWidget(getDeps: () => Promise<AttentionDeps>): WidgetModule {
  return {
    id: "attention",
    title: "Attention",
    updateMode: { type: "polling", intervalMs: 10_000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { repo, activeWindowKey } = await getDeps();

        // Load cohort for the active window (or fallback all-operator asks)
        const cohort = await loadCohort(repo, activeWindowKey);

        // Total pending: all suspended asks routed to operator (for header counter)
        const allSuspended = await repo.listByState("suspended");
        const totalPending = allSuspended.filter(
          (a) => a.routingTarget === "operator" && !isTerminal(a.state)
        ).length;

        const activeWindow: ActiveWindowInfo | null = activeWindowKey
          ? { windowKey: activeWindowKey }
          : null;

        const payload: AttentionPayload = {
          activeWindow,
          cohort: cohort.map(toAttentionAsk),
          totalPending,
        };

        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `attention error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Uses a lazily-initialised PersistenceService singleton — same bootstrap
// pattern as agents.ts. The cockpit is a standalone Express server with no
// tsyringe container.
//
// Window state: read from the SSE broker's ring buffer via latestForChannel().
// The broker subscribes to `minsky.attention_window_opened` and buffers the
// most recent event, so the active window key reflects the last Postgres NOTIFY
// received since cockpit-server startup (mt#1853). Falls back to null when no
// broker is available (non-Postgres provider, offline mode).
// ---------------------------------------------------------------------------

let _cachedRepo: AskRepository | null = null;
let _cachedBroker: import("../sse-broker").SseBroker | null = null;

const CHANNEL_ATTENTION_OPENED = "minsky.attention_window_opened";
const CHANNEL_ATTENTION_CLOSED = "minsky.attention_window_closed";

async function defaultDepsFactory(): Promise<AttentionDeps> {
  if (!_cachedRepo) {
    const { PersistenceService } = await import("@minsky/domain/persistence/service");
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");

    const svc = new PersistenceService();
    await svc.initialize();
    const provider = svc.getProvider();

    // Try to get DB connection via SQL capability
    if (
      !("getDatabaseConnection" in provider) ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      throw new Error("Persistence provider does not support SQL — AskRepository unavailable");
    }

    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    };
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) {
      throw new Error("getDatabaseConnection returned null — AskRepository unavailable");
    }
    _cachedRepo = new DrizzleAskRepository(db);
  }

  // Lazy-load the shared SSE broker to read the current active window key.
  // The broker is initialised eagerly at server startup (initServerSseBroker);
  // if that hasn't happened yet (e.g. widget fetch called before server init),
  // fall back to null and retry on the next fetch().
  if (!_cachedBroker) {
    try {
      const { getServerSseBrokerForWidget } = await import("../server");
      _cachedBroker = (await getServerSseBrokerForWidget()) ?? null;
    } catch {
      // Broker unavailable — will retry on next fetch()
    }
  }

  let activeWindowKey: string | null = null;
  if (_cachedBroker) {
    const latestOpenEvent = _cachedBroker.latestForChannel(CHANNEL_ATTENTION_OPENED);
    if (latestOpenEvent) {
      const openPayload = latestOpenEvent.payload as { windowKey?: string } | undefined;
      const openWindowKey = openPayload?.windowKey ?? null;

      if (openWindowKey) {
        // Check whether a subsequent CLOSE event has cancelled THIS specific
        // window. PR #1138 R3 NON-BLOCKING fix: a close event for a DIFFERENT
        // window (some sequential or concurrent open/close session) does NOT
        // cancel an unrelated still-open window. Cancellation requires both:
        //   (a) the close event targets the SAME windowKey as the latest open, AND
        //   (b) the close event is newer than the open event by numeric event ID.
        // This way: open(A) → close(B) does NOT clear A's active state.
        const latestCloseEvent = _cachedBroker.latestForChannel(CHANNEL_ATTENTION_CLOSED);
        let windowStillOpen = true;
        if (latestCloseEvent) {
          const closePayload = latestCloseEvent.payload as { windowKey?: string } | undefined;
          const closeWindowKey = closePayload?.windowKey ?? null;
          const closeIsNewer = parseInt(latestCloseEvent.id, 10) > parseInt(latestOpenEvent.id, 10);
          if (closeWindowKey === openWindowKey && closeIsNewer) {
            windowStillOpen = false;
          }
        }
        activeWindowKey = windowStillOpen ? openWindowKey : null;
      }
    }
  }

  return { repo: _cachedRepo, activeWindowKey };
}

/** Default attention widget — ready to drop into WIDGET_REGISTRY */
export const attentionWidget: WidgetModule = createAttentionWidget(defaultDepsFactory);
