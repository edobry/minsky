import { useEffect, useState, lazy, Suspense, type ComponentType } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WidgetShell } from "./components/WidgetShell";
import { useDeepLinkHandler } from "./hooks/useDeepLinkHandler";
import {
  fetchWidgets,
  fetchWidgetData,
  type WidgetMeta,
  type WidgetData,
} from "./lib/widget-client";
import { createCockpitSseClient } from "./lib/sse-client";
import { queryKeysForChannel } from "./lib/sse-invalidation";
import { Attention } from "./widgets/Attention";
import { BasicHealth } from "./widgets/BasicHealth";
import { CredentialsSummary } from "./widgets/Credentials";
import { EmbeddingsHealth } from "./widgets/EmbeddingsHealth";
import { McpServerStatus } from "./widgets/McpServerStatus";
import { ReviewerBotStatus } from "./widgets/ReviewerBotStatus";

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
const ConversationsPage = lazy(() =>
  import("./pages/ConversationsPage").then((m) => ({ default: m.ConversationsPage }))
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkstreamsPage = lazy(() =>
  import("./pages/WorkstreamsPage").then((m) => ({ default: m.WorkstreamsPage }))
);
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
  return <Navigate to={id ? `/conversation/${encodeURIComponent(id)}` : "/conversations"} replace />;
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
// Widget renderer maps
//
// Self-fetching widgets: own their data via TanStack Query; no data prop needed.
// These remain on the home page grid.
// ---------------------------------------------------------------------------
const SELF_FETCHING_RENDERERS: Record<string, ComponentType<{ title?: string }>> = {
  attention: Attention,
  credentials: CredentialsSummary,
  "embeddings-health": EmbeddingsHealth,
  "mcp-server-status": McpServerStatus,
  "reviewer-bot-status": ReviewerBotStatus,
};

// Prop-driven widgets: receive data from App-level polling.
const PROP_DRIVEN_RENDERERS: Record<string, ComponentType<{ data: WidgetData }>> = {
  "basic-health": BasicHealth,
};

// Widgets whose data App fetches at the app level and distributes via props:
//   - home-grid prop-driven cards (PROP_DRIVEN_RENDERERS), and
//   - promoted prop-driven page widgets whose routes receive data via props
//     (TasksLayout) rather than self-fetching.
// All other widgets — self-fetching home cards (attention, credentials, ...) and
// self-fetching page widgets (AgentsPage, MemoriesPage, ...) — own their data via
// the registry-gated /api/widget/:id/data endpoint and must NOT be polled
// app-wide. This keeps app-level background load bounded to a small fixed set,
// independent of how many widgets the registry contains (mt#2294).
// Workstreams migrated off this list to a param-aware self-fetching query
// (mt#2385 slice/altitude parameterization — see lib/use-workstreams-data.ts).
//
// Drift guard: the explicit page-widget entries below MUST also be in
// PAGE_ROUTE_WIDGET_IDS (they are prop-driven page routes whose data is plumbed
// via props — see taskGraphData below). A dev-time assertion
// enforces this so adding a self-fetching page widget here (which would start
// needless app-wide polling) fails fast rather than silently regressing load.
const APP_LEVEL_PAGE_PROP_WIDGET_IDS = ["task-graph"] as const;
const APP_LEVEL_PROP_WIDGET_IDS = new Set<string>([
  ...Object.keys(PROP_DRIVEN_RENDERERS),
  ...APP_LEVEL_PAGE_PROP_WIDGET_IDS,
]);

// IDs of widgets that have dedicated page routes — excluded from the home grid
// (see homeWidgets below). Their data strategy varies: only the ones ALSO in
// APP_LEVEL_PAGE_PROP_WIDGET_IDS (task-graph) are app-level-polled and
// prop-driven; the rest (agents, context-inspector, task-list, workstreams)
// self-fetch on their own pages. Workstreams self-fetches via a param-aware
// query hook (use-workstreams-data.ts) — do NOT re-add it to the app-level
// prop list: that would resurrect param-less app-wide polling and break the
// altitude-keyed caching (mt#2385).
//
// "context-inspector" (mt#2768): the standalone /context page + its React
// widget were retired (folded into the run-detail Context tab, keyed by a
// known conversation id — no picker, no standalone route). The backend
// widget itself stays registered as a DATA SOURCE (the sessions-picker rows
// `ConversationPage`'s header label and others read via `fetchWidgetData`) —
// it just has no home-grid renderer anymore, so it MUST stay in this set to
// avoid a "no frontend renderer registered" placeholder card reappearing on
// the home page.
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
// Home page grid — small widgets + page nav tiles
// ---------------------------------------------------------------------------

interface HomePageProps {
  widgets: WidgetState[];
}

function HomePage({ widgets }: HomePageProps) {
  return (
    <div className="p-4 flex flex-col gap-6 max-w-5xl mx-auto w-full">
      {/* System section — always first: "is anything wrong?" scan */}
      {widgets.length > 0 && (
        <section aria-label="System status">
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {widgets.map(({ meta, data }) => {
                const SelfFetchingRenderer = SELF_FETCHING_RENDERERS[meta.id];
                const PropDrivenRenderer = PROP_DRIVEN_RENDERERS[meta.id];

                return (
                  <ErrorBoundary key={meta.id} id={meta.id}>
                    {SelfFetchingRenderer ? (
                      meta.id === "attention" ? (
                        /* Attention is the algedonic top surface — give it the
                           full row so the default landing leads with it (mt#2398). */
                        <div className="md:col-span-2 lg:col-span-3">
                          <SelfFetchingRenderer title={meta.title} />
                        </div>
                      ) : (
                        <SelfFetchingRenderer title={meta.title} />
                      )
                    ) : !PropDrivenRenderer ? (
                      <WidgetShell variant="card" title={meta.title}>
                        <p className="text-muted-foreground text-sm">
                          Widget &apos;{meta.id}&apos; has no frontend renderer registered
                        </p>
                      </WidgetShell>
                    ) : data === null ? (
                      <WidgetShell variant="card" title={meta.title}>
                        <p className="text-muted-foreground text-sm">Loading...</p>
                      </WidgetShell>
                    ) : (
                      <PropDrivenRenderer data={data} />
                    )}
                  </ErrorBoundary>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Nav tiles removed (mt#2398): the persistent rail (mt#2397) is the
          navigation surface; the tile grid duplicated it. */}
    </div>
  );
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

  // Home page only receives the non-promoted, renderable widgets
  const homeWidgets = widgets.filter(
    (w) =>
      !PAGE_ROUTE_WIDGET_IDS.has(w.meta.id) &&
      (SELF_FETCHING_RENDERERS[w.meta.id] || PROP_DRIVEN_RENDERERS[w.meta.id])
  );

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
          <Route path="/" element={<HomePage widgets={homeWidgets} />} />
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
          <Route
            path="/conversations"
            element={
              <ErrorBoundary id="sessions-page">
                <ConversationsPage />
              </ErrorBoundary>
            }
          />
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