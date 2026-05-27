import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Types — mirrors server-side shapes
// ---------------------------------------------------------------------------

interface EmbeddingsHealthSummary {
  provider: string;
  status: "healthy" | "degraded" | "exhausted";
  lastErrorAt: string | null;
  errorCountLastHour: number;
  degradedReason: string | null;
}

interface ConsumerCoverage {
  consumer: string;
  total: number;
  indexed: number;
  missing: number;
  orphaned: number;
  coveragePct: number;
  lastIndexed: string | null;
  hasDomainTable: boolean;
  error?: string;
}

interface EmbeddingsOverview {
  health: EmbeddingsHealthSummary;
  consumers: ConsumerCoverage[];
}

interface EmbeddingsError {
  id: string;
  provider: string;
  errorCode: string;
  status: string;
  failureCount: number;
  degradedReason: string | null;
  createdAt: string;
}

interface EmbeddingsErrorsResponse {
  errors: EmbeddingsError[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchOverview(): Promise<EmbeddingsOverview> {
  const res = await fetch("/api/embeddings/overview");
  if (!res.ok) throw new Error(`Failed to fetch overview (${res.status})`);
  return res.json() as Promise<EmbeddingsOverview>;
}

async function fetchErrors(): Promise<EmbeddingsErrorsResponse> {
  const res = await fetch("/api/embeddings/errors?limit=50");
  if (!res.ok) throw new Error(`Failed to fetch errors (${res.status})`);
  return res.json() as Promise<EmbeddingsErrorsResponse>;
}

async function triggerReindex(consumer: string): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`/api/embeddings/reindex/${consumer}`, { method: "POST" });
  if (!res.ok) throw new Error(`Reindex failed (${res.status})`);
  return res.json() as Promise<{ success: boolean; message: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function statusColor(status: EmbeddingsHealthSummary["status"]): string {
  switch (status) {
    case "healthy":
      return "text-green-400";
    case "degraded":
      return "text-amber-400";
    case "exhausted":
      return "text-red-400";
  }
}

function statusBg(status: EmbeddingsHealthSummary["status"]): string {
  switch (status) {
    case "healthy":
      return "bg-green-400/10 border-green-400/20";
    case "degraded":
      return "bg-amber-400/10 border-amber-400/20";
    case "exhausted":
      return "bg-red-400/10 border-red-400/20";
  }
}

const CONSUMER_LABELS: Record<string, string> = {
  tasks: "Tasks",
  memories: "Memories",
  principal_corpus: "Principal Corpus",
  knowledge: "Knowledge",
};

const REINDEXABLE = new Set(["tasks", "principal_corpus", "knowledge"]);

// ---------------------------------------------------------------------------
// Provider Health Panel
// ---------------------------------------------------------------------------

function ProviderHealthPanel({ health }: { health: EmbeddingsHealthSummary }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Provider Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("rounded-md border p-3 space-y-2", statusBg(health.status))}>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Provider</span>
            <span className="text-sm font-mono">{health.provider}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Status</span>
            <span className={cn("text-sm font-semibold uppercase", statusColor(health.status))}>
              {health.status}
            </span>
          </div>
          {health.degradedReason && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Reason</span>
              <span className="text-sm font-mono text-muted-foreground">
                {health.degradedReason}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Errors (last hour)</span>
            <span className="text-sm tabular-nums">{health.errorCountLastHour}</span>
          </div>
          {health.lastErrorAt && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last error</span>
              <span className="text-sm tabular-nums">{formatRelative(health.lastErrorAt)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Index Coverage Table
// ---------------------------------------------------------------------------

function CoverageTable({
  consumers,
  onReindex,
  reindexingConsumer,
}: {
  consumers: ConsumerCoverage[];
  onReindex: (consumer: string) => void;
  reindexingConsumer: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Index Coverage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 font-medium">Consumer</th>
                <th className="pb-2 font-medium text-right">Total</th>
                <th className="pb-2 font-medium text-right">Indexed</th>
                <th className="pb-2 font-medium text-right">Coverage</th>
                <th className="pb-2 font-medium text-right">Missing</th>
                <th className="pb-2 font-medium text-right">Orphaned</th>
                <th className="pb-2 font-medium text-right">Last Indexed</th>
                <th className="pb-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {consumers.map((c) => (
                <tr key={c.consumer} className="border-b border-border/50">
                  <td className="py-2 font-medium">
                    {CONSUMER_LABELS[c.consumer] ?? c.consumer}
                    {!c.hasDomainTable && (
                      <span className="ml-1.5 text-xs text-muted-foreground">(standalone)</span>
                    )}
                    {c.error && (
                      <span className="ml-1.5 text-xs text-destructive" title={c.error}>
                        (query error)
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{c.total}</td>
                  <td className="py-2 text-right tabular-nums">{c.indexed}</td>
                  <td className="py-2 text-right tabular-nums">
                    {c.hasDomainTable ? (
                      <span
                        className={cn(
                          c.coveragePct < 90
                            ? "text-amber-400"
                            : c.coveragePct < 100
                              ? "text-muted-foreground"
                              : "text-green-400"
                        )}
                      >
                        {c.coveragePct}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {c.hasDomainTable ? (
                      <span className={c.missing > 0 ? "text-amber-400" : ""}>{c.missing}</span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {c.hasDomainTable ? (
                      <span className={c.orphaned > 0 ? "text-amber-400" : ""}>{c.orphaned}</span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums text-xs text-muted-foreground">
                    {c.lastIndexed ? formatRelative(c.lastIndexed) : "never"}
                  </td>
                  <td className="py-2 text-right">
                    {REINDEXABLE.has(c.consumer) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={reindexingConsumer === c.consumer}
                        onClick={() => onReindex(c.consumer)}
                      >
                        {reindexingConsumer === c.consumer ? "..." : "Reindex"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Error Log
// ---------------------------------------------------------------------------

function ErrorLog({ errors }: { errors: EmbeddingsError[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Recent Errors
          {errors.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {errors.length} event{errors.length !== 1 ? "s" : ""}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {errors.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No embedding errors recorded.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {errors.map((err) => (
              <div
                key={err.id}
                className="flex items-center gap-3 px-3 py-2 rounded-md border border-border bg-card text-sm"
              >
                <span className="w-5 h-5 flex items-center justify-center rounded text-xs font-bold flex-shrink-0 bg-destructive/20 text-destructive">
                  !
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-foreground truncate">
                    <span className="font-mono">{err.errorCode}</span>
                    {err.degradedReason && (
                      <span className="ml-2 text-muted-foreground">({err.degradedReason})</span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">{err.provider}</span>
                    <span className="text-xs text-muted-foreground">
                      {err.status} &middot; {err.failureCount} failures
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                  {formatRelative(err.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function EmbeddingsPage() {
  const queryClient = useQueryClient();
  const [reindexingConsumer, setReindexingConsumer] = useState<string | null>(null);

  const overviewQuery = useQuery<EmbeddingsOverview, Error>({
    queryKey: ["embeddings-overview"],
    queryFn: fetchOverview,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const errorsQuery = useQuery<EmbeddingsErrorsResponse, Error>({
    queryKey: ["embeddings-errors"],
    queryFn: fetchErrors,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const reindexMutation = useMutation({
    mutationFn: triggerReindex,
    onMutate: (consumer) => setReindexingConsumer(consumer),
    onSettled: () => {
      setReindexingConsumer(null);
      void queryClient.invalidateQueries({ queryKey: ["embeddings-overview"] });
    },
  });

  if (overviewQuery.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <p className="text-sm text-destructive">
          Failed to load embeddings overview: {overviewQuery.error.message}
        </p>
      </div>
    );
  }

  const overview = overviewQuery.data;
  const errors = errorsQuery.data?.errors ?? [];

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-4">
      <h1 className="text-base font-semibold text-foreground">Embeddings Infrastructure</h1>

      {overviewQuery.isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
      ) : overview ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ProviderHealthPanel health={overview.health} />
            <ErrorLog errors={errors} />
          </div>
          <CoverageTable
            consumers={overview.consumers}
            onReindex={(consumer) => reindexMutation.mutate(consumer)}
            reindexingConsumer={reindexingConsumer}
          />
        </>
      ) : null}
    </div>
  );
}
