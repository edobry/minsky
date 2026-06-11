import { useEffect, useState, lazy, Suspense, type ComponentType } from "react";
import { Routes, Route } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WidgetShell } from "./components/WidgetShell";
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
import { ContextInspector } from "./widgets/ContextInspector";
import { CredentialsSummary } from "./widgets/Credentials";
import { EmbeddingsHealth } from "./widgets/EmbeddingsHealth";
import { McpServerStatus } from "./widgets/McpServerStatus";

// Lazy-loaded page routes — each becomes its own chunk on first visit.
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage }))
);
const SessionDetailPage = lazy(() =>
  import("./pages/SessionDetailPage").then((m) => ({ default: m.SessionDetailPage }))
);
const ContextPage = lazy(() =>
  import("./pages/ContextPage").then((m) => ({ default: m.ContextPage }))
);
const SessionPage = lazy(() =>
  import("./pages/SessionPage").then((m) => ({ default: m.SessionPage }))
);
const SessionsPage = lazy(() =>
  import("./pages/SessionsPage").then((m) => ({ default: m.SessionsPage }))
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
const PlantPage = lazy(() => import("./pages/PlantPage").then((m) => ({ default: m.PlantPage })));
const PlantGridPage = lazy(() =>
  import("./pages/PlantGridPage").then((m) => ({ default: m.PlantGridPage }))
);
const PlantFlowPage = lazy(() =>
  import("./pages/PlantFlowPage").then((m) => ({ default: m.PlantFlowPage }))
);

// ---------------------------------------------------------------------------
// Widget renderer maps
//
// Self-fetching widgets: own their data via TanStack Query; no data prop needed.
// These remain on the home page grid.
// ---------------------------------------------------------------------------
const SELF_FETCHING_RENDERERS: Record<string, ComponentType<{ title?: string }>> = {
  attention: Attention,
  "context-inspector": ContextInspector,
  credentials: CredentialsSummary,
  "embeddings-health": EmbeddingsHealth,
  "mcp-server-status": McpServerStatus,
};

// Prop-driven widgets: receive data from App-level polling.
const PROP_DRIVEN_RENDERERS: Record<string, ComponentType<{ data: WidgetData }>> = {
  "basic-health": BasicHealth,
};

// Widgets whose data App fetches at the app level and distributes via props:
//   - home-grid prop-driven cards (PROP_DRIVEN_RENDERERS), and
//   - promoted prop-driven page widgets whose routes receive data via props
//     (WorkstreamsPage, TasksLayout) rather than self-fetching.
// All other widgets — self-fetching home cards (attention, credentials, ...) and
// self-fetching page widgets (AgentsPage, MemoriesPage, ...) — own their data via
// the registry-gated /api/widget/:id/data endpoint and must NOT be polled
// app-wide. This keeps app-level background load bounded to a small fixed set,
// independent of how many widgets the registry contains (mt#2294).
//
// Drift guard: the explicit page-widget entries below MUST also be in
// PAGE_ROUTE_WIDGET_IDS (they are prop-driven page routes whose data is plumbed
// via props — see workstreamsData / taskGraphData below). A dev-time assertion
// enforces this so adding a self-fetching page widget here (which would start
// needless app-wide polling) fails fast rather than silently regressing load.
const APP_LEVEL_PAGE_PROP_WIDGET_IDS = ["workstreams", "task-graph"] as const;
const APP_LEVEL_PROP_WIDGET_IDS = new Set<string>([
  ...Object.keys(PROP_DRIVEN_RENDERERS),
  ...APP_LEVEL_PAGE_PROP_WIDGET_IDS,
]);

// IDs of widgets that have dedicated page routes — App still polls their data
// so page routes receive it without a separate fetch setup.
const PAGE_ROUTE_WIDGET_IDS = new Set([
  "agents",
  "context-inspector",
  "workstreams",
  "task-graph",
  "task-list",
]);

// Drift guard (mt#2294): every app-level page-prop widget must be a real page
// route. If one isn't, it has no prop consumer and would only add needless
// app-wide polling — fail fast in dev rather than silently regress load.
if (process.env.NODE_ENV !== "production") {
  for (const id of APP_LEVEL_PAGE_PROP_WIDGET_IDS) {
    if (!PAGE_ROUTE_WIDGET_IDS.has(id)) {
      throw new Error(
        `APP_LEVEL_PAGE_PROP_WIDGET_IDS contains "${id}" which is not a page route ` +
          `(missing from PAGE_ROUTE_WIDGET_IDS) — app-level polling would run for a ` +
          `widget with no prop consumer. Fix the set (mt#2294).`
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
  const workstreamsData = widgets.find((w) => w.meta.id === "workstreams")?.data ?? null;
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
          {/* Workspace-session entity route (mt#1919): keyed by the Minsky
              workspace sessionId — distinct from /session/:id, which takes the
              harness agentSessionId (transcript). */}
          <Route
            path="/agents/:id"
            element={
              <ErrorBoundary id="session-detail-page">
                <SessionDetailPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/context"
            element={
              <ErrorBoundary id="context-page">
                <ContextPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/sessions"
            element={
              <ErrorBoundary id="sessions-page">
                <SessionsPage />
              </ErrorBoundary>
            }
          />
          {/* Session entity route (mt#2398): URL-addressable session tab; body is
              mt#2374's ConversationView, re-homed from the retired /conversation host. */}
          <Route
            path="/session/:id"
            element={
              <ErrorBoundary id="session-page">
                <SessionPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/workstreams"
            element={
              <ErrorBoundary id="workstreams-page">
                <WorkstreamsPage data={workstreamsData} />
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
          <Route
            path="/plant"
            element={
              <ErrorBoundary id="plant-page">
                <PlantPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/plant-grid"
            element={
              <ErrorBoundary id="plant-grid-page">
                <PlantGridPage />
              </ErrorBoundary>
            }
          />
          <Route
            path="/plant-flow"
            element={
              <ErrorBoundary id="plant-flow-page">
                <PlantFlowPage />
              </ErrorBoundary>
            }
          />
        </Routes>
      </Suspense>
    </Layout>
  );
}
