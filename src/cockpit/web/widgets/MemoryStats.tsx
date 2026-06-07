import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";

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

const TYPE_COLORS: Record<string, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

export function MemoryStats() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-stats"],
    queryFn: () => fetchWidgetData("memories-stats"),
    staleTime: 55_000,
    refetchInterval: 60_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Memory Stats</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }

  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError ? query.error.message : (query.data as { reason: string }).reason;
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Memory Stats</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">{reason}</CardContent>
      </Card>
    );
  }

  const payload = query.data.payload as MemoriesStatsPayload;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Memory Stats</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">{payload.total} total</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
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
      </CardContent>
    </Card>
  );
}
