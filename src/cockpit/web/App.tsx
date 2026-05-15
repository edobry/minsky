import { useEffect, useState, type ComponentType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { fetchWidgets, fetchWidgetData, type WidgetMeta, type WidgetData } from "./lib/widget-client";
import { createCockpitSseClient } from "./lib/sse-client";
import { queryKeysForChannel } from "./lib/sse-invalidation";
import { Agents } from "./widgets/Agents";
import { Attention } from "./widgets/Attention";
import { BasicHealth } from "./widgets/BasicHealth";
import { TaskGraph } from "./widgets/TaskGraph";
import { Workstreams } from "./widgets/Workstreams";

// Widgets that are self-fetching (use TanStack Query internally; receive no data prop)
const SELF_FETCHING_RENDERERS: Record<string, ComponentType> = {
  agents: Agents,
  attention: Attention,
};

// Widgets that receive data from App-level polling
const PROP_DRIVEN_RENDERERS: Record<string, ComponentType<{ data: WidgetData }>> = {
  "basic-health": BasicHealth,
  "task-graph": TaskGraph,
  workstreams: Workstreams,
};

interface WidgetState {
  meta: WidgetMeta;
  data: WidgetData | null;
}

export function App() {
  const [widgets, setWidgets] = useState<WidgetState[]>([]);
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // SSE adapter — invalidates TanStack Query cache on push events (mt#1148).
  //
  // When an SSE event fires for a channel we recognise, `queryKeysForChannel`
  // returns the list of cache keys to invalidate; TanStack Query then triggers
  // a refetch for every widget subscribed to that key.
  //
  // Opt-out: append `?disableSSE=1` to the page URL to fall back to
  // polling-only mode (useful for debugging or when the broker is unavailable).
  //
  // Failure handling: if SSE drops, `onDisconnect` fires and the page shows a
  // warning; widgets remain functional via their existing `refetchInterval`.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("disableSSE")) {
      return;
    }

    const client = createCockpitSseClient({
      onEvent: (event) => {
        const keys = queryKeysForChannel(event.channel);
        for (const queryKey of keys) {
          void queryClient.invalidateQueries({ queryKey: queryKey as string[] });
        }
      },
    });

    client.connect();
    return () => client.disconnect();
  }, [queryClient]);

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
        // Self-fetching widgets own their own data — skip App-level polling for them
        if (SELF_FETCHING_RENDERERS[meta.id]) {
          continue;
        }

        // Initial fetch
        fetchWidgetData(meta.id)
          .then((data) => {
            if (!cancelled) {
              setWidgets((prev) =>
                prev.map((w) => (w.meta.id === meta.id ? { ...w, data } : w))
              );
            }
          })
          .catch(() => {});

        // Set up polling for polling-mode widgets
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

  return (
    <Layout>
      {widgets.map(({ meta, data }) => {
        const SelfFetchingRenderer = SELF_FETCHING_RENDERERS[meta.id];
        const PropDrivenRenderer = PROP_DRIVEN_RENDERERS[meta.id];

        return (
          <ErrorBoundary key={meta.id} id={meta.id}>
            {SelfFetchingRenderer ? (
              // Self-fetching widget — no data prop needed; widget owns its own fetch
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
    </Layout>
  );
}
