import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

// Mirrors ReviewerBotStatusPayload in src/cockpit/widgets/reviewer-bot-status.ts.
// No server imports on the frontend (cockpit web is a separate module graph).

interface ReviewerDbStats {
  reviewCount24h: number;
  failureCount24h: number;
  lastError: string | null;
  recentTaskIds: string[];
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  staleInflightCount: number;
  rateLimitHitCount24h: number;
  lastWebhookReceivedAt: string | null;
}

interface ReviewerBotStatusPayload {
  health: {
    ok: boolean;
    statusCode: number | null;
    lastProbeAt: string;
    inflightCount: number | null;
    provider: string | null;
    model: string | null;
    tier2Enabled: boolean | null;
  };
  db: ReviewerDbStats | null;
  anomalies: {
    a1ServiceUnreachable: boolean;
    a2StaleInflight: boolean;
    a3FailureRateSpike: boolean;
    a4LatencyRegression: boolean;
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function formatRelative(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "—";
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

function formatLatencyMs(ms: number | null): string {
  if (ms === null) return "—";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}m`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-right max-w-[60%]">{children}</dd>
    </div>
  );
}

function AnomalyBanner({
  message,
  variant = "error",
}: {
  message: string;
  variant?: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "mb-2 rounded px-2 py-1 text-xs",
        variant === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-500"
      )}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body (chrome-agnostic)
// ---------------------------------------------------------------------------

interface ReviewerBotStatusBodyProps {
  query: UseQueryResult<WidgetData, Error>;
}

function ReviewerBotStatusBody({ query }: ReviewerBotStatusBodyProps) {
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">Failed to load: {query.error.message}</p>
    );
  }

  if (query.isLoading || !query.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  if (query.data.state === "degraded") {
    return <p className="text-muted-foreground text-sm">{query.data.reason}</p>;
  }

  const payload = query.data.payload as ReviewerBotStatusPayload;
  const { health, db, anomalies } = payload;

  return (
    <>
      {/* Status badge */}
      <div className="flex items-center gap-1.5 mb-2">
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full",
            health.ok ? "bg-emerald-500" : "bg-destructive"
          )}
          aria-label={health.ok ? "Status: Healthy" : "Status: Unreachable"}
        />
        <span
          className={cn(
            "text-xs px-1.5 py-0.5 rounded",
            health.ok
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-destructive/10 text-destructive"
          )}
        >
          {health.ok ? "Healthy" : "Unreachable"}
        </span>
      </div>

      {/* Anomaly banners */}
      {anomalies.a1ServiceUnreachable && (
        <AnomalyBanner
          message={`A1 — Service unreachable (status: ${health.statusCode ?? "no response"}). Check Railway logs.`}
        />
      )}
      {anomalies.a2StaleInflight && db && (
        <AnomalyBanner
          message={`A2 — ${db.staleInflightCount} stale in-flight review(s) (acquired >10m ago). Worker may be stuck.`}
          variant="warning"
        />
      )}
      {anomalies.a3FailureRateSpike && db && (
        <AnomalyBanner
          message={`A3 — Failure-rate spike: ${db.failureCount24h} failures out of ${db.reviewCount24h + db.failureCount24h} events in last 24h.`}
        />
      )}
      {anomalies.a4LatencyRegression && db && (
        <AnomalyBanner
          message={`A4 — Latency regression: P95 = ${formatLatencyMs(db.p95LatencyMs)} (threshold: 120s).`}
          variant="warning"
        />
      )}

      {/* Field rows — 14 v1 fields */}
      <dl>
        {/* Field 1: Health check */}
        <Row label="Health check">
          {health.ok ? (
            <span className="text-emerald-500">200 OK</span>
          ) : (
            <span className="text-destructive">{health.statusCode ?? "no response"}</span>
          )}
        </Row>

        {/* Field 2: In-flight count (from /health) */}
        <Row label="In-flight reviews">
          {health.inflightCount !== null ? (
            <span>{health.inflightCount}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 3: Provider */}
        <Row label="Provider">
          {health.provider ?? <span className="text-muted-foreground">—</span>}
        </Row>

        {/* Field 4: Model */}
        <Row label="Model">
          {health.model ?? <span className="text-muted-foreground">—</span>}
        </Row>

        {/* Field 5: Tier 2 enabled */}
        <Row label="Tier 2 enabled">
          {health.tier2Enabled !== null ? (
            <span className={health.tier2Enabled ? "text-emerald-500" : "text-muted-foreground"}>
              {health.tier2Enabled ? "Yes" : "No"}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 6: Review throughput (last 24h) */}
        <Row label="Reviews (24h)">
          {db !== null ? (
            <span>{db.reviewCount24h}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 7: Failure count + last error */}
        <Row label="Failures (24h)">
          {db !== null ? (
            <span
              className={db.failureCount24h > 0 ? "text-destructive" : undefined}
              title={db.lastError ?? undefined}
            >
              {db.failureCount24h}
              {db.lastError ? " ⚠" : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 8: Recent mt# tasks reviewed (from head_ref) */}
        <Row label="Recent tasks">
          {db !== null && db.recentTaskIds.length > 0 ? (
            <span className="text-right text-xs leading-relaxed">
              {db.recentTaskIds.join(", ")}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 9: Average review latency */}
        <Row label="Avg latency (24h)">{db !== null ? formatLatencyMs(db.avgLatencyMs) : "—"}</Row>

        {/* Field 10: P95 review latency */}
        <Row label="P95 latency (24h)">
          {db !== null ? (
            <span className={anomalies.a4LatencyRegression ? "text-amber-500" : undefined}>
              {formatLatencyMs(db.p95LatencyMs)}
            </span>
          ) : (
            "—"
          )}
        </Row>

        {/* Field 11: Stale in-flight count */}
        <Row label="Stale in-flight">
          {db !== null ? (
            <span className={db.staleInflightCount > 0 ? "text-amber-500" : undefined}>
              {db.staleInflightCount}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 12: Failure rate */}
        <Row label="Failure rate (24h)">
          {db !== null ? (
            (() => {
              const total = db.reviewCount24h + db.failureCount24h;
              if (total === 0) return <span className="text-muted-foreground">no data</span>;
              const pct = (db.failureCount24h / total) * 100;
              return (
                <span className={anomalies.a3FailureRateSpike ? "text-destructive" : undefined}>
                  {pct.toFixed(1)}%
                </span>
              );
            })()
          ) : (
            "—"
          )}
        </Row>

        {/* Field 13: Rate-limit hit count */}
        <Row label="Rate-limit hits (24h)">
          {db !== null ? (
            <span className={db.rateLimitHitCount24h > 0 ? "text-amber-500" : undefined}>
              {db.rateLimitHitCount24h}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 14: Last webhook received */}
        <Row label="Last webhook">
          {db !== null && db.lastWebhookReceivedAt ? (
            <span title={db.lastWebhookReceivedAt}>
              {formatRelative(db.lastWebhookReceivedAt)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>
      </dl>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface Props {
  variant?: WidgetVariant;
  title?: string;
}

export function ReviewerBotStatus({ variant = "card", title = "Reviewer Bot" }: Props) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "reviewer-bot-status"],
    queryFn: () => fetchWidgetData("reviewer-bot-status"),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <ReviewerBotStatusBody query={query} />
    </WidgetShell>
  );
}
