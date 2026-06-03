import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";

interface MemoriesHealthPayload {
  provider: string;
  status: "healthy" | "degraded" | "exhausted";
  degradedReason: string | null;
  fallbackActive: boolean;
  fallbackProvider: string | null;
  errorCountLastHour: number;
  lastErrorAt: string | null;
}

function statusDotColor(status: MemoriesHealthPayload["status"]): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500";
    case "degraded":
      return "bg-amber-500";
    case "exhausted":
      return "bg-destructive";
  }
}

function statusTextColor(status: MemoriesHealthPayload["status"]): string {
  switch (status) {
    case "healthy":
      return "text-emerald-500";
    case "degraded":
      return "text-amber-500";
    case "exhausted":
      return "text-destructive";
  }
}

/** Compact single-row health indicator for the memories page header. */
export function MemoriesHealth() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-health"],
    queryFn: () => fetchWidgetData("memories-health"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-muted animate-pulse" />
        <span>Checking embeddings health…</span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive">
        <span className="inline-block h-2 w-2 rounded-full bg-destructive" />
        <span>Health check failed</span>
      </div>
    );
  }

  const data = query.data;

  if (data.state === "degraded") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
        <span>{data.reason}</span>
      </div>
    );
  }

  const payload = data.payload as MemoriesHealthPayload;

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span
          className={cn("inline-block h-2 w-2 rounded-full", statusDotColor(payload.status))}
          aria-label={`Embeddings status: ${payload.status}`}
        />
        <span className={cn("font-medium", statusTextColor(payload.status))}>
          {payload.status === "healthy"
            ? "Embeddings healthy"
            : payload.status === "degraded"
              ? "Embeddings degraded"
              : "Embeddings exhausted"}
        </span>
      </div>

      {payload.provider !== "unknown" && (
        <span className="text-muted-foreground">
          via <span className="font-mono">{payload.provider}</span>
        </span>
      )}

      {payload.degradedReason && (
        <span className="text-amber-500 truncate max-w-[260px]" title={payload.degradedReason}>
          — {payload.degradedReason}
        </span>
      )}

      {payload.fallbackActive && payload.fallbackProvider && (
        <span className="text-muted-foreground">
          (fallback: <span className="font-mono">{payload.fallbackProvider}</span>)
        </span>
      )}
    </div>
  );
}
