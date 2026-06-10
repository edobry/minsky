import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

interface MemoriesStatsPayload {
  total: number;
  supersededCount: number;
  byType: {
    user: number;
    feedback: number;
    project: number;
    reference: number;
  };
  recentCount: number;
  topAccessed: Array<{
    id: string;
    name: string;
    accessCount: number;
  }>;
}

interface MemoryStatsProps {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

const TYPE_COLORS: Record<string, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

function MemoryStatsBody({ query }: { query: ReturnType<typeof useQuery<WidgetData, Error>> }) {
  if (query.isLoading || !query.data) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError ? query.error.message : (query.data as { reason: string }).reason;
    return <p className="text-xs text-muted-foreground">{reason}</p>;
  }

  const payload = query.data.payload as MemoriesStatsPayload;

  return (
    <div className="space-y-3">
      {/* Total count — was inline in CardTitle flex row */}
      <p className="text-xs text-muted-foreground tabular-nums text-right -mt-1">
        {payload.total} total
      </p>

      {/* Type breakdown */}
      <div className="flex flex-wrap gap-1.5">
        {(["user", "feedback", "project", "reference"] as const).map((t) => (
          <span
            key={t}
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs",
              TYPE_COLORS[t]
            )}
          >
            <span className="capitalize">{t}</span>
            <span className="tabular-nums font-mono">{payload.byType[t]}</span>
          </span>
        ))}
      </div>

      {/* Quick stats row */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center justify-between py-1 border-b border-border">
          <span className="text-muted-foreground">Last 7 days</span>
          <span className="tabular-nums">{payload.recentCount}</span>
        </div>
        <div className="flex items-center justify-between py-1 border-b border-border">
          <span className="text-muted-foreground">Superseded</span>
          <span className="tabular-nums text-muted-foreground">{payload.supersededCount}</span>
        </div>
      </div>

      {/* Top accessed */}
      {payload.topAccessed.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Most accessed</p>
          <ul className="space-y-1">
            {payload.topAccessed.map((m) => (
              <li key={m.id} className="flex items-center justify-between text-xs">
                <span className="truncate max-w-[160px]" title={m.name}>
                  {m.name}
                </span>
                <span className="text-muted-foreground tabular-nums ml-2 flex-shrink-0">
                  {m.accessCount}×
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget export (mt#2373)
// ---------------------------------------------------------------------------

export function MemoryStats({ variant = "card", title = "Memory Stats" }: MemoryStatsProps = {}) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-stats"],
    queryFn: () => fetchWidgetData("memories-stats"),
    staleTime: 55_000,
    refetchInterval: 60_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <MemoryStatsBody query={query} />
    </WidgetShell>
  );
}
