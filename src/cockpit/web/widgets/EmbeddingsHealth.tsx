import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { LinkCard } from "../components/ui/link-card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";

const EMBEDDINGS_LINK_LABEL = "View embedding infrastructure details";

interface CoverageStats {
  tasks: { indexed: number; total: number };
  memories: { indexed: number; total: number };
}

interface EmbeddingsHealthPayload {
  provider: string;
  status: "healthy" | "degraded" | "exhausted";
  lastErrorAt: string | null;
  errorCountLastHour: number;
  degradedReason: string | null;
  coverage: CoverageStats | null;
}

function statusColor(status: EmbeddingsHealthPayload["status"]): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500";
    case "degraded":
      return "bg-amber-500";
    case "exhausted":
      return "bg-destructive";
  }
}

function statusLabel(status: EmbeddingsHealthPayload["status"]): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "exhausted":
      return "Exhausted";
  }
}

function coveragePercent(indexed: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((indexed / total) * 100)}%`;
}

function CoverageRow({ label, indexed, total }: { label: string; indexed: number; total: number }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {indexed}/{total}{" "}
        <span className="text-muted-foreground">({coveragePercent(indexed, total)})</span>
      </dd>
    </div>
  );
}

function formatRelative(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  if (isNaN(diffMs)) return "unknown";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function EmbeddingsHealth() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "embeddings-health"],
    queryFn: () => fetchWidgetData("embeddings-health"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  if (query.isError) {
    return (
      <LinkCard to="/embeddings" aria-label={EMBEDDINGS_LINK_LABEL}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Embeddings</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load: {query.error.message}</p>
        </CardContent>
      </LinkCard>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <LinkCard to="/embeddings" aria-label={EMBEDDINGS_LINK_LABEL}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Embeddings</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Loading…</p>
        </CardContent>
      </LinkCard>
    );
  }

  const data = query.data;

  if (data.state === "degraded") {
    return (
      <LinkCard to="/embeddings" aria-label={EMBEDDINGS_LINK_LABEL}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Embeddings</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>{data.reason}</p>
        </CardContent>
      </LinkCard>
    );
  }

  const payload = data.payload as EmbeddingsHealthPayload;

  return (
    <LinkCard to="/embeddings" aria-label={EMBEDDINGS_LINK_LABEL}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">Embeddings</CardTitle>
          <div className="flex items-center gap-1.5">
            <span
              className={cn("inline-block h-2 w-2 rounded-full", statusColor(payload.status))}
              aria-label={`Status: ${statusLabel(payload.status)}`}
            />
            <span
              className={cn(
                "text-xs px-1.5 py-0.5 rounded",
                payload.status === "healthy"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : payload.status === "degraded"
                    ? "bg-amber-500/10 text-amber-500"
                    : "bg-destructive/10 text-destructive"
              )}
            >
              {statusLabel(payload.status)}
            </span>
            <ChevronRight
              aria-hidden
              className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl>
          <div className="flex items-center justify-between py-1.5 border-b border-border text-sm">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="tabular-nums">
              {payload.provider === "unknown" ? "—" : payload.provider}
            </dd>
          </div>

          {payload.coverage && (
            <>
              <CoverageRow
                label="Tasks indexed"
                indexed={payload.coverage.tasks.indexed}
                total={payload.coverage.tasks.total}
              />
              <CoverageRow
                label="Memories indexed"
                indexed={payload.coverage.memories.indexed}
                total={payload.coverage.memories.total}
              />
            </>
          )}

          {payload.status !== "healthy" && payload.degradedReason && (
            <div className="flex items-center justify-between py-1.5 border-b border-border text-sm">
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="text-destructive text-xs max-w-[60%] text-right">
                {payload.degradedReason}
              </dd>
            </div>
          )}

          {payload.lastErrorAt && (
            <div className="flex items-center justify-between py-1.5 text-sm">
              <dt className="text-muted-foreground">Last error</dt>
              <dd className="tabular-nums text-muted-foreground" title={payload.lastErrorAt}>
                {formatRelative(payload.lastErrorAt)}
              </dd>
            </div>
          )}
        </dl>
      </CardContent>
    </LinkCard>
  );
}
