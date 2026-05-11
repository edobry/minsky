import { useEffect, useState, type ComponentType } from "react";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Card, CardHeader, CardTitle, CardContent } from "./components/Card";
import { fetchWidgets, fetchWidgetData, type WidgetMeta, type WidgetData } from "./lib/widget-client";
import { Agents } from "./widgets/Agents";
import { AttentionStub } from "./widgets/AttentionStub";
import { BasicHealth } from "./widgets/BasicHealth";

const WIDGET_RENDERERS: Record<string, ComponentType<{ data: WidgetData }>> = {
  agents: Agents,
  "attention-stub": AttentionStub,
  "basic-health": BasicHealth,
};

interface WidgetState {
  meta: WidgetMeta;
  data: WidgetData | null;
}

export function App() {
  const [widgets, setWidgets] = useState<WidgetState[]>([]);

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
        const Renderer = WIDGET_RENDERERS[meta.id];
        return (
          <ErrorBoundary key={meta.id} id={meta.id}>
            {!Renderer ? (
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
              <Renderer data={data} />
            )}
          </ErrorBoundary>
        );
      })}
    </Layout>
  );
}
