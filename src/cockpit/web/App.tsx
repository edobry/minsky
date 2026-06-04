import { useEffect, useState, type ComponentType } from "react";
import { Routes, Route } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
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
import { AgentsPage } from "./pages/AgentsPage";
import { ContextPage } from "./pages/ContextPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkstreamsPage } from "./pages/WorkstreamsPage";
import { TasksLayout } from "./pages/TasksLayout";
import { TasksListPage } from "./pages/TasksListPage";
import { TasksGraphPage } from "./pages/TasksGraphPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { AsksPage } from "./pages/AsksPage";
import { ActivityPage } from "./pages/ActivityPage";
import { EmbeddingsPage } from "./pages/EmbeddingsPage";
import { MemoriesPage } from "./pages/MemoriesPage";
import { PageNavTiles } from "./pages/HomePage";

// ---------------------------------------------------------------------------
// Widget renderer maps
//
// Self-fetching widgets: own their data via TanStack Query; no data prop needed.
// These remain on the home page grid.
// ---------------------------------------------------------------------------
const SELF_FETCHING_RENDERERS: Record<string, ComponentType> = {
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

// IDs of widgets that have dedicated page routes — App still polls their data
// so page routes receive it without a separate fetch setup.
const PAGE_ROUTE_WIDGET_IDS = new Set([
  "agents",
  "context-inspector",
  "workstreams",
  "task-graph",
  "task-list",
]);

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
                      <SelfFetchingRenderer />
                    ) : !PropDrivenRenderer ? (
                      <Card>
                        <CardHeader>
                          <CardTitle>{meta.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-muted-foreground">
                          <p>Widget &apos;{meta.id}&apos; has no frontend renderer registered</p>
                        </CardContent>
                      </Card>
                    ) : data === null ? (
                      <Card>
                        <CardHeader>
                          <CardTitle>{meta.title}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-muted-foreground">
                          <p>Loading...</p>
                        </CardContent>
                      </Card>
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

      {/* Navigate section — below status: where am I going? */}
      <PageNavTiles />
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
        // Self-fetching widgets own their own data
        if (SELF_FETCHING_RENDERERS[meta.id]) {
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
        <Route
          path="/context"
          element={
            <ErrorBoundary id="context-page">
              <ContextPage />
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
      </Routes>
    </Layout>
  );
}