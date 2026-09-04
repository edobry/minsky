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
import { isSqlCapable } from "@minsky/domain/persistence/types";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";
import type { ProjectScope } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import {
  pendingAsksForWindow,
  compareAskPriority,
} from "@minsky/domain/ask/pending-asks-for-window";
import { isTerminal } from "@minsky/domain/ask/state-machine";
import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { describeWidgetDegradedReason } from "../db-providers";

// ---------------------------------------------------------------------------
// Public payload shapes — mirrored in Attention.tsx; keep in sync.
// ---------------------------------------------------------------------------

/** Serialisable Ask subset for the widget payload. */
export interface AttentionAsk {
  id: string;
  /**
   * The ask's `ask#N` short id (ADR-029), when it has one. Absent for asks
   * minted before the short-id backfill. Consumed by the entity linkifier's
   * id-set so a bare `ask#3346` in prose resolves (mt#3259); the uuid `id`
   * above stays canonical.
   */
  shortId?: string;
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
    shortId: ask.shortId,
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
 *
 * @param projectScope  Project scope for filtering (mt#4727). Defaults to
 *   ALL_PROJECTS when omitted, matching `AskRepository.listByState`'s own
 *   default.
 */
export async function loadCohort(
  repo: AskRepository,
  windowKey: string | null,
  projectScope?: ProjectScope
): Promise<Ask[]> {
  const nowMs = Date.now();

  if (windowKey) {
    return pendingAsksForWindow(repo, windowKey, nowMs, projectScope);
  }

  // Fallback: pending operator asks (no active window).
  //
  // Covers `routed` as well as `suspended` (mt#4313). `pendingAsksForWindow`
  // above already spans both states, and once the reaper actually runs, a woken
  // ask sits in `routed` from the moment its window opens until it is answered.
  // Reading only `suspended` here would drop exactly those asks the moment the
  // window closed — windows are open 30-60 minutes a day, so this branch is the
  // widget's normal state and the ask would be invisible until the next one.
  const operatorAsks = await pendingOperatorAsks(repo, projectScope);
  operatorAsks.sort(compareAskPriority);
  return operatorAsks;
}

/**
 * Every operator-routed ask still awaiting an answer, ignoring windows.
 *
 * Extracted (mt#4775) so the header COUNT and the cohort LIST cannot drift
 * apart. The header used to run its own `listByState("suspended")`, so it
 * undercounted the very list it heads by exactly the asks sitting in `routed` —
 * invisible whenever nothing was woken, which is why it surfaced as an
 * intermittent off-by-N (home 40 vs /asks 41) rather than a constant one. One
 * predicate, two callers.
 */
export async function pendingOperatorAsks(
  repo: AskRepository,
  projectScope?: ProjectScope
): Promise<Ask[]> {
  const [routed, suspended] = await Promise.all([
    repo.listByState("routed", projectScope),
    repo.listByState("suspended", projectScope),
  ]);
  return [...routed, ...suspended].filter(
    (a) => a.routingTarget === "operator" && !isTerminal(a.state)
  );
}

// ---------------------------------------------------------------------------
// Deps interface — injectable for tests
// ---------------------------------------------------------------------------

export interface AttentionDeps {
  repo: AskRepository;
  /** Currently open window key — null if no window is open. */
  activeWindowKey: string | null;
  /**
   * Optional test seam (mt#4727, mirrors task-list.ts's mt#3016 seam):
   * overrides `resolveCockpitProjectScope`'s own db-fetch. Production
   * callers never set this — the default factory omits it, so
   * `resolveCockpitProjectScope` falls back to its own `defaultGetDb` (the
   * real `getContextInspectorDb()` singleton).
   */
  getDb?: () => Promise<ScopeResolverDb | null>;
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
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { repo, activeWindowKey, getDb } = await getDeps();

        // Project scope (mt#4727): ?project=<slug> resolved to a project
        // uuid, defaulting to ALL_PROJECTS when omitted/"all" — same
        // resolution rules as every other cockpit project-scoped read
        // (mt#2418 pattern, task-list.ts:91-93). resolveCockpitProjectScope
        // owns its own db-fetch and never throws (fail-open to ALL_PROJECTS
        // on any resolution failure — PR #2056 R1), so a scoping problem can
        // never take this widget down.
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, { getDb });

        // Load cohort for the active window (or fallback all-operator asks)
        const cohort = await loadCohort(repo, activeWindowKey, projectScope);

        // Total pending: the SAME predicate `loadCohort` uses, deliberately
        // (mt#4775). This read `suspended` only while the no-window branch of
        // `loadCohort` above reads `routed` + `suspended`, so the header
        // undercounted the very list it heads by exactly the operator asks
        // sitting in `routed` — which is where a woken ask lives from the moment
        // its window opens until it is answered. The two agreed whenever nothing
        // was `routed`, which is why this surfaced as an intermittent off-by-N
        // (home 40 vs /asks 41) rather than a constant one, and why a test built
        // on a homogeneous fixture would pass against the unfixed code.
        const totalPending = (await pendingOperatorAsks(repo, projectScope)).length;

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
        return { state: "degraded", reason: describeWidgetDegradedReason("attention", err) };
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

const CHANNEL_ATTENTION_OPENED = "minsky.attention_window_opened";
const CHANNEL_ATTENTION_CLOSED = "minsky.attention_window_closed";

/**
 * AskRepository cached per persistence epoch (mt#3721).
 *
 * `DrizzleAskRepository` closes over the `db` handle it was constructed with,
 * so a pool recycle (`recycleSharedPersistence`, mt#3638) leaves it querying a
 * torn-down pool — which postgres-js rejects forever, since `CONNECTION_ENDED`
 * is raised off an `ending` flag nothing clears. Before mt#3721 this cache had
 * no epoch check and this widget served `degraded` indefinitely after a recycle
 * that had already restored the pool.
 */
const getCachedAskRepo = createEpochKeyedCache(async (): Promise<AskRepository> => {
  {
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");

    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    // Capability + method, via the one guard (mt#4543) — the comment above said "via SQL
    // capability" while the check asked only whether the method existed.
    if (!isSqlCapable(provider)) {
      // The provider is already in hand here, so call the domain helper
      // directly rather than db-providers' re-fetching wrapper (mt#3661).
      throw new Error(`AskRepository unavailable — ${describePersistenceUnavailability(provider)}`);
    }

    // No cast — `isSqlCapable` narrowed (PR #3324 R1).
    const db = await provider.getDatabaseConnection();
    if (!db) {
      // Same class as the capability check above, and just as cause-free before
      // mt#3661 — a null connection from a provider that CLAIMED SQL capability.
      throw new Error(
        `AskRepository unavailable — getDatabaseConnection returned null. ${describePersistenceUnavailability(provider)}`
      );
    }
    return new DrizzleAskRepository(db);
  }
});

async function defaultDepsFactory(): Promise<AttentionDeps> {
  const repo = await getCachedAskRepo();

  // Read the shared SSE broker to get the current active window key. The broker
  // is initialised eagerly at server startup (initServerSseBroker); if that
  // hasn't happened yet (e.g. widget fetch called before server init), fall back
  // to null and retry on the next fetch().
  //
  // Deliberately NOT cached here (mt#3721): `getServerSseBrokerForWidget` is
  // already a cached accessor, and that cache is epoch-keyed at the source since
  // the broker holds a LISTEN connection from the provider. A second copy of the
  // reference here would pin the CLOSED broker across a recycle while the
  // accessor served the live one — the same latch this task exists to remove,
  // reintroduced one layer up.
  let broker: import("../sse-broker").SseBroker | null = null;
  try {
    const { getServerSseBrokerForWidget } = await import("../routes/events");
    broker = (await getServerSseBrokerForWidget()) ?? null;
  } catch {
    // Broker unavailable — will retry on next fetch()
  }

  let activeWindowKey: string | null = null;
  if (broker) {
    const latestOpenEvent = broker.latestForChannel(CHANNEL_ATTENTION_OPENED);
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
        const latestCloseEvent = broker.latestForChannel(CHANNEL_ATTENTION_CLOSED);
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

  return { repo, activeWindowKey };
}

/** Default attention widget — ready to drop into WIDGET_REGISTRY */
export const attentionWidget: WidgetModule = createAttentionWidget(defaultDepsFactory);
