import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

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

/**
 * Chrome-agnostic body for the embeddings-health indicator (mt#2373): renders
 * the status dot + label and any degraded/fallback detail, with no surrounding
 * frame. Self-fetching (owns its TanStack Query). The surrounding chrome is
 * supplied by {@link WidgetShell}.
 */
function MemoriesHealthBody() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-health"],
    queryFn: () => fetchWidgetData("memories-health"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-muted animate-pulse" />
        <span>Checking embeddings health…</span>
      </span>
    );
  }

  if (query.isError) {
    return (
      <span className="flex items-center gap-2 text-destructive">
        <span className="inline-block h-2 w-2 rounded-full bg-destructive" />
        <span>Health check failed</span>
      </span>
    );
  }

  const data = query.data;

  if (data.state === "degraded") {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
        <span>{data.reason}</span>
      </span>
    );
  }

  const payload = data.payload as MemoriesHealthPayload;

  return (
    <>
      <span className="flex items-center gap-1.5">
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
      </span>

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
    </>
  );
}

interface Props {
  /** Render-context variant; defaults to the compact single-row header presentation. */
  variant?: WidgetVariant;
}

/**
 * Embeddings-health indicator. Defaults to the `compact` variant (the memories
 * page header row); the same body can now render as a card or rail item via
 * {@link WidgetShell} (mt#2373). Title is registry-sourced.
 */
export function MemoriesHealth({ variant = "compact" }: Props) {
  return (
    <WidgetShell variant={variant} title="Embeddings" className="text-xs">
      <MemoriesHealthBody />
    </WidgetShell>
  );
}
