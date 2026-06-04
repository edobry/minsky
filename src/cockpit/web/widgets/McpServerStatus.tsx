import { useQuery } from "@tanstack/react-query";
import { CardHeader, CardTitle, CardContent, Card } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";

// Mirrors McpServerStatusPayload in src/cockpit/widgets/mcp-server-status.ts.
type DeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "CRASHED"
  | "UNKNOWN";

interface McpServerStatusPayload {
  health: {
    ok: boolean;
    statusCode: number | null;
    lastProbeAt: string;
    consecutiveFailureMs: number;
  };
  lastDowntimeAt: string | null;
  uptime24hPct: number | null;
  deploy: {
    commitHash: string | null;
    commitMessage: string | null;
    lastDeployAt: string | null;
    status: DeploymentStatus;
  } | null;
  recentErrors: string[];
  anomalies: {
    m1HealthFailing: boolean;
    m2DeployFailed: boolean;
  };
}

type OverallStatus = "healthy" | "unreachable" | "down";

function overallStatus(payload: McpServerStatusPayload): OverallStatus {
  if (payload.anomalies.m1HealthFailing) return "down";
  if (!payload.health.ok) return "unreachable";
  return "healthy";
}

function statusDotColor(status: OverallStatus): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500";
    case "unreachable":
      return "bg-amber-500";
    case "down":
      return "bg-destructive";
  }
}

function statusLabel(status: OverallStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "unreachable":
      return "Unreachable";
    case "down":
      return "Down";
  }
}

// Param is `string`, not `DeploymentStatus`: the payload arrives as an untrusted
// JSON cast (`as McpServerStatusPayload`), so the domain could add a status value
// the web bundle hasn't been rebuilt for. The `default` branch keeps any unseen
// value rendering with muted styling instead of an undefined className.
function deployStatusColor(status: string): string {
  switch (status) {
    case "SUCCESS":
      return "bg-emerald-500/10 text-emerald-500";
    case "BUILDING":
    case "DEPLOYING":
      return "bg-amber-500/10 text-amber-500";
    case "FAILED":
    case "CRASHED":
    case "CANCELLED":
      return "bg-destructive/10 text-destructive";
    case "UNKNOWN":
    default:
      return "bg-muted text-muted-foreground";
  }
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

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function shortSha(hash: string | null): string {
  if (!hash) return "—";
  return hash.slice(0, 7);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-right max-w-[60%]">{children}</dd>
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">MCP Server</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">{children}</CardContent>
    </Card>
  );
}

export function McpServerStatus() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "mcp-server-status"],
    queryFn: () => fetchWidgetData("mcp-server-status"),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  if (query.isError) {
    return <CardShell>Failed to load: {query.error.message}</CardShell>;
  }

  if (query.isLoading || !query.data) {
    return <CardShell>Loading…</CardShell>;
  }

  if (query.data.state === "degraded") {
    return <CardShell>{query.data.reason}</CardShell>;
  }

  const payload = query.data.payload as McpServerStatusPayload;
  const status = overallStatus(payload);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">MCP Server</CardTitle>
          <div className="flex items-center gap-1.5">
            <span
              className={cn("inline-block h-2 w-2 rounded-full", statusDotColor(status))}
              aria-label={`Status: ${statusLabel(status)}`}
            />
            <span
              className={cn(
                "text-xs px-1.5 py-0.5 rounded",
                status === "healthy"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : status === "unreachable"
                    ? "bg-amber-500/10 text-amber-500"
                    : "bg-destructive/10 text-destructive"
              )}
            >
              {statusLabel(status)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {payload.anomalies.m1HealthFailing && (
          <div className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            M1 — Health check failing for {formatDuration(payload.health.consecutiveFailureMs)}.
            Hosted MCP is down; check Railway.
          </div>
        )}
        {payload.anomalies.m2DeployFailed && payload.deploy && (
          <div className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            M2 — Latest deploy outcome is {payload.deploy.status}. Revert or push a fix.
          </div>
        )}

        <dl>
          <Row label="Health check">
            {payload.health.ok ? (
              <span className="text-emerald-500">200 OK</span>
            ) : (
              <span className="text-destructive">{payload.health.statusCode ?? "no response"}</span>
            )}
          </Row>

          <Row label="Uptime (24h)">
            {payload.uptime24hPct === null ? "—" : `${payload.uptime24hPct.toFixed(1)}%`}
          </Row>

          <Row label="Last downtime">
            {payload.lastDowntimeAt ? (
              <span title={payload.lastDowntimeAt}>{formatRelative(payload.lastDowntimeAt)}</span>
            ) : (
              <span className="text-muted-foreground">none recorded</span>
            )}
          </Row>

          <Row label="Version">
            {payload.deploy ? (
              <span title={payload.deploy.commitMessage ?? undefined}>
                {shortSha(payload.deploy.commitHash)}
              </span>
            ) : (
              "—"
            )}
          </Row>

          <Row label="Last deploy">
            {payload.deploy ? (
              <span className="inline-flex items-center gap-1.5">
                {payload.deploy.lastDeployAt ? (
                  <span className="text-muted-foreground" title={payload.deploy.lastDeployAt}>
                    {formatRelative(payload.deploy.lastDeployAt)}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded",
                    deployStatusColor(payload.deploy.status)
                  )}
                >
                  {payload.deploy.status}
                </span>
              </span>
            ) : (
              "—"
            )}
          </Row>

          <Row label="Recent errors">
            {payload.recentErrors.length === 0 ? (
              <span className="text-muted-foreground">none</span>
            ) : (
              <span className="text-destructive" title={payload.recentErrors.join("\n")}>
                {payload.recentErrors.length}
              </span>
            )}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
