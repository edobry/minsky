import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

// Mirrors ReviewerBotStatusPayload in src/cockpit/widgets/reviewer-bot-status.ts.
// No server imports on the frontend (cockpit web is a separate module graph).

interface VerdictCounts {
  approve: number;
  requestChanges: number;
  comment: number;
}

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
  medianTokens24h: number | null;
  medianTokens7d: number | null;
  medianCostUsd24h: number | null;
  medianCostUsd7d: number | null;
  cacheHitRatio24h: number | null;
  verdictCounts24h: VerdictCounts;
  verdictCounts7d: VerdictCounts;
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
    a5CostTrend: boolean;
    a6VerdictDrift: boolean;
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

function formatTokens(n: number | null): string {
  if (n === null) return "—";
  // Defensive: medians are integer by construction (PERCENTILE_DISC), but round
  // so a fractional value never renders as e.g. "45,000.5".
  return Math.round(n).toLocaleString();
}

function formatCost(n: number | null): string {
  if (n === null) return "—";
  // Small per-review costs (typically <$1); show more precision below $1.
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Total verdict count across all three classes. */
function verdictTotal(counts: VerdictCounts): number {
  return counts.approve + counts.requestChanges + counts.comment;
}

/** Ratio of one verdict class within its window's total. Null when the window has no verdicts. */
function verdictRatio(counts: VerdictCounts, key: keyof VerdictCounts): number | null {
  const total = verdictTotal(counts);
  return total > 0 ? counts[key] / total : null;
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
    return <p className="text-muted-foreground text-sm">Failed to load: {query.error.message}</p>;
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
            health.ok ? "bg-emerald-500/10 text-emerald-500" : "bg-destructive/10 text-destructive"
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
      {anomalies.a5CostTrend && db && (
        <AnomalyBanner
          message={`A5 — Cost trend: 24h median ${formatCost(db.medianCostUsd24h)} vs 7d median ${formatCost(db.medianCostUsd7d)} (>50% divergence).`}
          variant="warning"
        />
      )}
      {anomalies.a6VerdictDrift && db && (
        <AnomalyBanner
          message="A6 — Verdict drift: 24h verdict ratio diverged >20pp from the 7d baseline. The bot may be getting stricter or looser."
          variant="warning"
        />
      )}

      {/* Field rows — 14 v1 fields */}
      <dl>
        {/* Field 1: Health check (with probe recency) */}
        <Row label="Health check">
          <span className="flex flex-col items-end gap-0.5">
            {health.ok ? (
              <span className="text-emerald-500">200 OK</span>
            ) : (
              <span className="text-destructive">{health.statusCode ?? "no response"}</span>
            )}
            <span className="text-xs text-muted-foreground" title={health.lastProbeAt}>
              probed {formatRelative(health.lastProbeAt)}
            </span>
          </span>
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
        <Row label="Model">{health.model ?? <span className="text-muted-foreground">—</span>}</Row>

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
          {db !== null
            ? (() => {
                const total = db.reviewCount24h + db.failureCount24h;
                if (total === 0) return <span className="text-muted-foreground">no data</span>;
                const pct = (db.failureCount24h / total) * 100;
                return (
                  <span className={anomalies.a3FailureRateSpike ? "text-destructive" : undefined}>
                    {pct.toFixed(1)}%
                  </span>
                );
              })()
            : "—"}
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
            <span title={db.lastWebhookReceivedAt}>{formatRelative(db.lastWebhookReceivedAt)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>

        {/* Field 15: Median tokens per review (24h) — mt#2288 */}
        <Row label="Median tokens (24h)">
          {db !== null ? formatTokens(db.medianTokens24h) : "—"}
        </Row>

        {/* Field 16: Median tokens per review (7d) — mt#2288 */}
        <Row label="Median tokens (7d)">{db !== null ? formatTokens(db.medianTokens7d) : "—"}</Row>

        {/* Field 17: Median cost per review (24h) — mt#2288 */}
        <Row label="Median cost (24h)">
          {db !== null ? (
            <span className={anomalies.a5CostTrend ? "text-amber-500" : undefined}>
              {formatCost(db.medianCostUsd24h)}
            </span>
          ) : (
            "—"
          )}
        </Row>

        {/* Field 18: Median cost per review (7d) — mt#2288 */}
        <Row label="Median cost (7d)">{db !== null ? formatCost(db.medianCostUsd7d) : "—"}</Row>

        {/* Field 19: Cache-hit ratio (24h) — mt#2721. Cached input / total input. */}
        <Row label="Cache-hit (24h)">{db !== null ? formatPercent(db.cacheHitRatio24h) : "—"}</Row>
      </dl>

      {/* Verdict distribution (mt#2287) — 24h counts/ratios per verdict + 7d
          baseline for comparison, with per-row amber highlighting when that
          verdict's ratio has drifted >20pp between windows. */}
      {db !== null && (
        <div className="mt-3 pt-2 border-t border-border">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-medium text-muted-foreground">Verdict distribution</span>
            {anomalies.a6VerdictDrift && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">
                drift
              </span>
            )}
          </div>
          <dl>
            {(
              [
                ["Approve", "approve"],
                ["Request changes", "requestChanges"],
                ["Comment", "comment"],
              ] as const
            ).map(([label, key]) => {
              const ratio24h = verdictRatio(db.verdictCounts24h, key);
              const ratio7d = verdictRatio(db.verdictCounts7d, key);
              // Gate the per-row amber highlight on the SAME sample-size gate as
              // the global A6 anomaly (mt#2287 R1): when a6VerdictDrift is
              // suppressed (e.g. both windows below A6_MIN_SAMPLE_SIZE), no row
              // should light up either — otherwise a single low-volume review
              // trivially "drifts" 100pp and highlights while the header badge
              // (correctly) stays hidden.
              const diverged =
                anomalies.a6VerdictDrift &&
                ratio24h !== null &&
                ratio7d !== null &&
                Math.abs(ratio24h - ratio7d) > 0.2;
              return (
                <Row key={key} label={label}>
                  <span
                    className={cn(
                      "flex flex-col items-end gap-0.5",
                      diverged ? "text-amber-500" : undefined
                    )}
                  >
                    <span>
                      {db.verdictCounts24h[key]} ({formatPercent(ratio24h)})
                    </span>
                    <span className="text-xs text-muted-foreground">
                      7d: {formatPercent(ratio7d)}
                    </span>
                  </span>
                </Row>
              );
            })}
          </dl>
        </div>
      )}
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
