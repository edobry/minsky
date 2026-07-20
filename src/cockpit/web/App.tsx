import { useEffect, useState, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useDeepLinkHandler } from "./hooks/useDeepLinkHandler";
import {
  fetchWidgets,
  fetchWidgetData,
  type WidgetMeta,
  type WidgetData,
} from "./lib/widget-client";
import { createCockpitSseClient } from "./lib/sse-client";
import { queryKeysForChannel } from "./lib/sse-invalidation";
import { HomePage } from "./pages/HomePage";

// Lazy-loaded page routes — each becomes its own chunk on first visit.
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage }))
);
const WorkspaceDetailPage = lazy(() =>
  import("./pages/WorkspaceDetailPage").then((m) => ({ default: m.WorkspaceDetailPage }))
);
const ConversationPage = lazy(() =>
  import("./pages/ConversationPage").then((m) => ({ default: m.ConversationPage }))
);
const DrivenSessionPage = lazy(() =>
  import("./pages/DrivenSessionPage").then((m) => ({ default: m.DrivenSessionPage }))
);
const DrivenSessionCostPage = lazy(() =>
  import("./pages/DrivenSessionCostPage").then((m) => ({ default: m.DrivenSessionCostPage }))
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkstreamsPage = lazy(() =>
  import("./pages/WorkstreamsPage").then((m) => ({ default: m.WorkstreamsPage }))
);
const DigestPage = lazy(() => import("./pages/DigestPage").then((m) => ({ default: m.DigestPage })));
const TasksLayout = lazy(() =>
  import("./pages/TasksLayout").then((m) => ({ default: m.TasksLayout }))
);
const TasksListPage = lazy(() =>
  import("./pages/TasksListPage").then((m) => ({ default: m.TasksListPage }))
);
const TasksGraphPage = lazy(() =>
  import("./pages/TasksGraphPage").then((m) => ({ default: m.TasksGraphPage }))
);
const TaskDetailPage = lazy(() =>
  import("./pages/TaskDetailPage").then((m) => ({ default: m.TaskDetailPage }))
);
const AsksPage = lazy(() => import("./pages/AsksPage").then((m) => ({ default: m.AsksPage })));
const AskPage = lazy(() => import("./pages/AskPage").then((m) => ({ default: m.AskPage })));
const ChangesetDetailPage = lazy(() =>
  import("./pages/ChangesetDetailPage").then((m) => ({ default: m.ChangesetDetailPage }))
);
const ChangesetsPage = lazy(() =>
  import("./pages/ChangesetsPage").then((m) => ({ default: m.ChangesetsPage }))
);
const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage }))
);
const EmbeddingsPage = lazy(() =>
  import("./pages/EmbeddingsPage").then((m) => ({ default: m.EmbeddingsPage }))
);
const MemoriesPage = lazy(() =>
  import("./pages/MemoriesPage").then((m) => ({ default: m.MemoriesPage }))
);
const MemoryPage = lazy(() =>
  import("./pages/MemoryPage").then((m) => ({ default: m.MemoryPage }))
);
const PlantFlowPage = lazy(() =>
  import("./pages/PlantFlowPage").then((m) => ({ default: m.PlantFlowPage }))
);
const WeldHistoryPage = lazy(() =>
  import("./pages/WeldHistoryPage").then((m) => ({ default: m.WeldHistoryPage }))
);
const VitalsPage = lazy(() =>
  import("./pages/VitalsPage").then((m) => ({ default: m.VitalsPage }))
);

/**
 * Legacy `/session/:id` deep-link redirect (mt#2769).
 *
 * The `/session/:id` route registration itself was already removed (renamed
 * to `/conversation/:id` per ADR-022 stage 1, mt#2686) — but old deep links
 * and localStorage-persisted tabs (`lib/tabs.tsx`'s `STORAGE_KEY`) still
 * carry the pre-rename path. Rather than 404, redirect to the renamed route
 * so those old links keep resolving. The `lib/tabs.tsx` `loadTabs()` loader
 * also migrates persisted tab entries directly (a page visit isn't required
 * to fix the tab strip), but this route covers a fresh browser navigation to
 * a bookmarked or externally-shared `/session/:id` URL.
 *
 * Exported for direct unit testing (mirrors `plantRoutes`'s export rationale).
 */
export function SessionIdRedirect() {
  const { id } = useParams<{ id: string }>();
  // mt#2767: /conversations retired (redirects to /agents) — the no-id
  // fallback now points there directly rather than through a second hop.
  return <Navigate to={id ? `/conversation/${encodeURIComponent(id)}` : "/agents"} replace />;
}

/**
 * Plant board routes — the node-link whole-system view (ADR-020, converged
 * mt#2423: the SVG schematic and panel-grid comparison routes are retired;
 * old paths redirect for bookmark continuity).
 *
 * Exported as a Routes-children fragment so the redirect wiring is testable
 * (react-router flattens fragments via createRoutesFromChildren).
 */
export const plantRoutes = (
  <>
    <Route
      path="/plant"
      element={
        <ErrorBoundary id="plant-page">
          <PlantFlowPage />
        </ErrorBoundary>
      }
    />
    <Route path="/plant-grid" element={<Navigate to="/plant" replace />} />
    <Route path="/plant-flow" element={<Navigate to="/plant" replace />} />
    {/*
     * Interlock-history drill-down (mt#2602): interlock provenance timeline.
     * Route renamed from `/plant/weld-history` (mt#2626, guard vocabulary
     * alignment — "interlock" is the domain noun; "weld" survives only as a
     * verb). Accepted as a breaking rename — local-only cockpit, no external
     * consumers/bookmarks to preserve, so no redirect route was added.
     */}
    <Route
      path="/plant/interlock-history"
      element={
        <ErrorBoundary id="interlock-history-page">
          <WeldHistoryPage />
        </ErrorBoundary>
      }
    />
  </>
);

// ---------------------------------------------------------------------------
// App-level prop-driven widgets (mt#2881: the home grid's renderer maps are
// gone — HomePage is a fixed, curated composition of self-fetching bands, see
// pages/HomePage.tsx. The only remaining app-level-polled widget is the
// promoted task-graph page, whose route receives data via props.)
// ---------------------------------------------------------------------------
const APP_LEVEL_PAGE_PROP_WIDGET_IDS = ["task-graph"] as const;
const APP_LEVEL_PROP_WIDGET_IDS = new Set<string>([...APP_LEVEL_PAGE_PROP_WIDGET_IDS]);

// IDs of widgets that have dedicated page routes — their data strategy varies:
// only the ones ALSO in APP_LEVEL_PAGE_PROP_WIDGET_IDS (task-graph) are
// app-level-polled and prop-driven; the rest (agents, context-inspector,
// task-list, workstreams) self-fetch on their own pages. Workstreams
// self-fetches via a param-aware query hook (use-workstreams-data.ts) — do NOT
// re-add it to the app-level prop list: that would resurrect param-less
// app-wide polling and break the altitude-keyed caching (mt#2385).
//
// "context-inspector" (mt#2768): the standalone /context page + its React
// widget were retired (folded into the run-detail Context tab). The backend
// widget stays registered as a DATA SOURCE only.
const PAGE_ROUTE_WIDGET_IDS = new Set([
  "agents",
  "context-inspector",
  "workstreams",
  "task-graph",
  "task-list",
]);

// Page widgets that own their data via self-fetching queries — these must
// NEVER appear in APP_LEVEL_PAGE_PROP_WIDGET_IDS. Workstreams in particular
// is param-aware (altitude-keyed query cache, mt#2385); app-level param-less
// polling would duplicate its fetches and bypass the keyed cache.
const SELF_FETCHING_PAGE_WIDGET_IDS = ["agents", "context-inspector", "task-list", "workstreams"] as const;

// Drift guards (mt#2294, mt#2385) — fail fast in dev rather than silently
// regress load or caching:
//  1. Every app-level page-prop widget must be a real page route; otherwise it
//     has no prop consumer and app-wide polling runs for nothing.
//  2. No self-fetching page widget may be app-level-polled; that would
//     reintroduce param-less app-wide polling alongside its own queries.
if (process.env.NODE_ENV !== "production") {
  for (const id of APP_LEVEL_PAGE_PROP_WIDGET_IDS) {
    if (!PAGE_ROUTE_WIDGET_IDS.has(id)) {
      throw new Error(
        `APP_LEVEL_PAGE_PROP_WIDGET_IDS contains "${id}" which is not a page route ` +
          `(missing from PAGE_ROUTE_WIDGET_IDS) — app-level polling would run for a ` +
          `widget with no prop consumer. Fix the set (mt#2294).`
      );
    }
    if ((SELF_FETCHING_PAGE_WIDGET_IDS as readonly string[]).includes(id)) {
      throw new Error(
        `APP_LEVEL_PAGE_PROP_WIDGET_IDS contains "${id}" which is a self-fetching ` +
          `page widget — app-level polling would duplicate its fetches and bypass ` +
          `its query-keyed cache. Remove it from the app-level prop list (mt#2385).`
      );
    }
  }
}

interface WidgetState {
  meta: WidgetMeta;
  data: WidgetData | null;
}

// ---------------------------------------------------------------------------
// Root App component
// ---------------------------------------------------------------------------

export function App() {
  const [widgets, setWidgets] = useState<WidgetState[]>([]);
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // minsky:// deep-link handler (mt#2528, ADR-023).
  // Installs window.__minskyDeepLink and drains window.__minskyPendingDeepLink.
  // Called once; the hook is inside the router tree so useNavigate is available.
  // ---------------------------------------------------------------------------
  useDeepLinkHandler();

  // ---------------------------------------------------------------------------
  // SSE adapter — invalidates TanStack Query cache on push events (mt#1148).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("disableSSE")) {
      return;
    }

    const client = createCockpitSseClient({
      onEvent: (event) => {
        const keys = queryKeysForChannel(event.channel);
        for (const queryKey of keys) {
          void queryClient.invalidateQueries({ queryKey });
        }
      },
    });

    client.connect();
    return () => client.disconnect();
  }, [queryClient]);

  // ---------------------------------------------------------------------------
  // App-level polling for prop-driven widgets (including promoted ones so their
  // pages receive data immediately without a separate fetch setup).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const intervalIds: ReturnType<typeof setInterval>[] = [];

    async function init() {
      let metas: WidgetMeta[];
      try {
        metas = await fetchWidgets();
      } catch {
        return;
      }
      if (cancelled) return;

      setWidgets(metas.map((meta) => ({ meta, data: null })));

      for (const meta of metas) {
        // Only app-level-fetch widgets App distributes via props. Everything
        // else — self-fetching home cards and self-fetching page widgets —
        // owns its own data via the registry-gated data endpoint, so polling
        // them here would add background load for widgets App never renders.
        if (!APP_LEVEL_PROP_WIDGET_IDS.has(meta.id)) {
          continue;
        }

        // Initial fetch for prop-driven widgets (including promoted ones)
        fetchWidgetData(meta.id)
          .then((data) => {
            if (!cancelled) {
              setWidgets((prev) => prev.map((w) => (w.meta.id === meta.id ? { ...w, data } : w)));
            }
          })
          .catch(() => {});

        // Polling for polling-mode widgets
        if (meta.updateMode.type === "polling") {
          const id = setInterval(() => {
            fetchWidgetData(meta.id)
              .then((data) => {
                if (!cancelled) {
                  setWidgets((prev) =>
                    prev.map((w) => (w.meta.id === meta.id ? { ...w, data } : w))
                  );
                }
              })
              .catch(() => {});
          }, meta.updateMode.intervalMs);
          intervalIds.push(id);
        }
      }
    }

    init().catch(() => {});

    return () => {
      cancelled = true;
      for (const id of intervalIds) {
        clearInterval(id);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Data accessors for promoted page routes
  // ---------------------------------------------------------------------------
  const taskGraphData = widgets.find((w) => w.meta.id === "task-graph")?.data ?? null;

  return (
    <Layout>
      <Suspense
        fallback={
          <div className="p-4 text-muted-foreground text-sm" aria-live="polite">
            Loading…
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/agents"
            element={
              <ErrorBoundary id="agents-page">
                <AgentsPage />
              </ErrorBoundary>
            }
          />
          {/* Workspace entity route (mt#1919): keyed by the Minsky workspace
              sessionId — distinct from /conversation/:id, which takes the
              harness agentSessionId (transcript). Renamed from
              SessionDetailPage per ADR-022 stage 1 (mt#2686); the /agents/:id
              path itself is unchanged (the Agents list/detail pair is a
              separate naming decision, out of scope here).
              Tab sub-routes (mt#2768): the shared RunDetail body derives its
              active tab from the URL (Overview is the landing/default tab,
              omitted from the path); "conversation" and "context" are the
              only two accepted literal suffixes — this MUST stay in lockstep
              with `lib/tabs.tsx`'s `matchEntityRoute` regex, which normalizes
              all three paths to ONE entity-tab-strip entry. */}
          <Route
            path="/agents/:id"
            element={
              <ErrorBoundary id="session-detail-page">
                <WorkspaceDetailPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/agents/:id/conversation"
            element={
              <ErrorBoundary id="session-detail-page">
                <WorkspaceDetailPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/agents/:id/context"
            element={
              <ErrorBoundary id="session-detail-page">
                <WorkspaceDetailPage />
              </ErrorBoundary>
            }
          />
          {/* Retired standalone Context page (mt#2768): folded into the
              run-detail Context tab. Redirect for bookmark continuity. */}
          <Route path="/context" element={<Navigate to="/agents" replace />} />
          {/* Retired standalone Conversations list (mt#2767): /agents is now
              the unified agent-run list — workspace sessions, standalone
              conversations, and collapsed subagent groups in one browse
              surface. Redirect for bookmark continuity (mirrors the
              /context -> /agents pattern above from mt#2768). */}
          <Route path="/conversations" element={<Navigate to="/agents" replace />} />
          {/* Conversation entity route (mt#2398): URL-addressable conversation
              tab; body is mt#2374's ConversationView, re-homed from the retired
              /conversation host. Path renamed from /session/:id per ADR-022
              stage 1 (mt#2686) — the old URL used "session" for what this page
              always meant: a harness conversation transcript.
              Tab sub-routes (mt#2768): symmetric to /agents/:id above —
              Conversation is the landing/default tab (omitted from the path);
              "overview" and "context" are the only two accepted suffixes. */}
          <Route
            path="/conversation/:id"
            element={
              <ErrorBoundary id="session-page">
                <ConversationPage />
              </ErrorBoundary>
            }
          />
          {/* Driven-session view (mt#2751 Rung 2B): consumes mt#2750's per-session
              WS channel — hosts ConversationView + composer + status for a
              session the operator is actively driving. Launch entry points
              (starting a new session, task binding) are Rung 2C, out of scope
              here — this route is reachable directly by id/deeplink. */}
          <Route
            path="/driven/:id"
            element={
              <ErrorBoundary id="driven-session-page">
                <DrivenSessionPage />
              </ErrorBoundary>
            }
          />
          {/* Driven-session cost/usage readout (mt#2753, Rung 2D): per-session
              and aggregate spend/usage rolled up from the driven_session_cost
              table. Registered as a sub-route of /agents (the driven-session
              home) rather than under /driven/:id — this is a cross-session
              view, not scoped to one live session. */}
          <Route
            path="/agents/cost"
            element={
              <ErrorBoundary id="driven-session-cost-page">
                <DrivenSessionCostPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/conversation/:id/overview"
            element={
              <ErrorBoundary id="session-page">
                <ConversationPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/conversation/:id/context"
            element={
              <ErrorBoundary id="session-page">
                <ConversationPage />
              </ErrorBoundary>
            }
          />
          {/* Legacy redirect (mt#2769): /session/:id was the pre-mt#2686 path for
              the route above. Old deep links / persisted tabs still reference it. */}
          <Route path="/session/:id" element={<SessionIdRedirect />} />
          <Route
            path="/workstreams"
            element={
              <ErrorBoundary id="workstreams-page">
                <WorkstreamsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/digest"
            element={
              <ErrorBoundary id="digest-page">
                <DigestPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/tasks"
            element={
              <ErrorBoundary id="tasks-layout">
                <TasksLayout taskGraphData={taskGraphData} />
              </ErrorBoundary>
            }
          >
            <Route index element={<TasksListPage />} />
            <Route path="graph" element={<TasksGraphPage />} />
            {/* React Router v7 matches literal "graph" before ":id" so no conflict */}
            <Route path=":id" element={<TaskDetailPage />} />
          </Route>
          <Route
            path="/asks"
            element={
              <ErrorBoundary id="asks-page">
                <AsksPage />
              </ErrorBoundary>
            }
          />
          {/* Ask entity route (mt#2410, mt#2398 PR2): URL-addressable ask tab. */}
          <Route
            path="/ask/:id"
            element={
              <ErrorBoundary id="ask-page">
                <AskPage />
              </ErrorBoundary>
            }
          />
          {/* Changeset entity route (mt#2535): URL-addressable changeset/PR detail tab.
              Id is the changeset id — keyed to PR number (github-pr adapter). */}
          <Route
            path="/changeset/:id"
            element={
              <ErrorBoundary id="changeset-page">
                <ChangesetDetailPage />
              </ErrorBoundary>
            }
          />
          {/* Changesets list route (mt#1920): active PRs across sessions. */}
          <Route
            path="/changesets"
            element={
              <ErrorBoundary id="changesets-page">
                <ChangesetsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/activity"
            element={
              <ErrorBoundary id="activity-page">
                <ActivityPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/settings"
            element={
              <ErrorBoundary id="settings-page">
                <SettingsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/embeddings"
            element={
              <ErrorBoundary id="embeddings-page">
                <EmbeddingsPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/memories"
            element={
              <ErrorBoundary id="memories-page">
                <MemoriesPage />
              </ErrorBoundary>
            }
          />
          {/* Memory entity route (mt#2410, mt#2398 PR2): URL-addressable memory tab. */}
          <Route
            path="/memory/:id"
            element={
              <ErrorBoundary id="memory-page">
                <MemoryPage />
              </ErrorBoundary>
            }
          />
          {plantRoutes}
          {/* Phone vital-signs view (mt#2601): compressed four-loop sibling of /plant. */}
          <Route
            path="/vitals"
            element={
              <ErrorBoundary id="vitals-page">
                <VitalsPage />
              </ErrorBoundary>
            }
          />
        </Routes>
      </Suspense>
    </Layout>
  );
}