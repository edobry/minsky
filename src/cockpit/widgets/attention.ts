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
import type { AskRepository } from "../../domain/ask/repository";
import type { Ask } from "../../domain/ask/types";
import { pendingAsksForWindow, compareAskPriority } from "../../domain/ask/pending-asks-for-window";
import { isTerminal } from "../../domain/ask/state-machine";

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
// Window state: the in-process OpenWindowRegistry singleton lives in the CLI
// entry point (src/adapters/shared/commands/window/index.ts). The cockpit
// server runs in a different process, so it cannot read that registry
// directly. v0: no active window key — surfacing all operator-routed suspended
// asks as the fallback cohort. v1 (post-mt#1148): the cockpit server will
// subscribe to Postgres NOTIFY `minsky.attention_window_opened` and maintain
// its own window-key state.
// ---------------------------------------------------------------------------

let _cachedRepo: AskRepository | null = null;

async function defaultDepsFactory(): Promise<AttentionDeps> {
  if (!_cachedRepo) {
    const { PersistenceService } = await import("../../domain/persistence/service");
    const { DrizzleAskRepository } = await import("../../domain/ask/repository");

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

  return { repo: _cachedRepo, activeWindowKey: null };
}

/** Default attention widget — ready to drop into WIDGET_REGISTRY */
export const attentionWidget: WidgetModule = createAttentionWidget(defaultDepsFactory);
