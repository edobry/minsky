import { useEffect, useState, type ComponentType } from "react";
import { Routes, Route } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { fetchWidgets, fetchWidgetData, type WidgetMeta, type WidgetData } from "./lib/widget-client";
import { createCockpitSseClient } from "./lib/sse-client";
import { queryKeysForChannel } from "./lib/sse-invalidation";
import { Attention } from "./widgets/Attention";
import { BasicHealth } from "./widgets/BasicHealth";
import { Credentials } from "./widgets/Credentials";
// Promoted widgets — rendered at their dedicated page routes
import { AgentsPage } from "./pages/AgentsPage";
import { WorkstreamsPage } from "./pages/WorkstreamsPage";
import { TasksPage } from "./pages/TasksPage";
import { PromotedPageTiles } from "./pages/HomePage";

// ---------------------------------------------------------------------------
// Widget renderer maps
//
// Self-fetching widgets: own their data via TanStack Query; no data prop needed.
// These remain on the home page grid.
// ---------------------------------------------------------------------------
const SELF_FETCHING_RENDERERS: Record<string, ComponentType> = {
  attention: Attention,
  credentials: Credentials,
};

// Prop-driven widgets: receive data from App-level polling.
// agents, workstreams, task-graph are promoted to their own pages;
// they still receive polling data from App state.
const PROP_DRIVEN_RENDERERS: Record<string, ComponentType<{ data: WidgetData }>> = {
  "basic-health": BasicHealth,
};

// IDs of the three promoted widgets — App still polls their data so page routes
// receive it without a separate fetch setup.
const PROMOTED_WIDGET_IDS = new Set(["agents", "workstreams", "task-graph"]);

interface WidgetState {
  meta: WidgetMeta;
  data: WidgetData | null;
}

// ---------------------------------------------------------------------------
// Home page grid — small widgets + promoted-page entry tiles
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
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            System
          </p>
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
        </section>
      )}

      {/* Navigate section — below status: where am I going? */}
      <PromotedPageTiles />
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
              setWidgets((prev) =>
                prev.map((w) => (w.meta.id === meta.id ? { ...w, data } : w))
              );
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
      !PROMOTED_WIDGET_IDS.has(w.meta.id) &&
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
            <ErrorBoundary id="tasks-page">
              <TasksPage data={taskGraphData} />
            </ErrorBoundary>
          }
        />
      </Routes>
    </Layout>
  );
}
