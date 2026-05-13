import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";

// Inline mirror of the server AgentRow shape — frontend must stay self-contained
// (no imports of server code). Keep in sync with src/cockpit/widgets/agents.ts.
interface AgentRow {
  sessionId: string;
  title: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned";
  taskId: string | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
  agentId: string | null;
}

interface AgentsPayload {
  agents: AgentRow[];
}

type AgentsWidgetData =
  | { state: "ok"; payload: AgentsPayload }
  | { state: "degraded"; reason: string };

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchAgentsData(): Promise<AgentsWidgetData> {
  const res = await fetch("/api/widget/agents/data");
  if (!res.ok) {
    throw new Error(`Agents endpoint returned ${res.status}`);
  }
  return res.json() as Promise<AgentsWidgetData>;
}

// ---------------------------------------------------------------------------
// Liveness helpers
// ---------------------------------------------------------------------------

/** Semantic Tailwind class for each liveness value — uses the liveness-* token group */
function livenessDotClass(liveness: AgentRow["liveness"]): string {
  switch (liveness) {
    case "healthy":
      return "bg-liveness-healthy";
    case "idle":
      return "bg-liveness-idle";
    case "stale":
      return "bg-liveness-stale";
    case "orphaned":
      return "bg-liveness-orphaned";
  }
}

function livenessLabel(liveness: AgentRow["liveness"]): string {
  switch (liveness) {
    case "healthy":
      return "healthy";
    case "idle":
      return "idle";
    case "stale":
      return "stale";
    case "orphaned":
      return "orphaned";
  }
}

// ---------------------------------------------------------------------------
// Relative-time helper — no external dep
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

// ---------------------------------------------------------------------------
// Agent row component
// ---------------------------------------------------------------------------

function AgentRowItem({ agent }: { agent: AgentRow }) {
  const label = livenessLabel(agent.liveness);
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
      {/* Liveness dot — screen-reader accessible via role="status" + aria-label */}
      <span
        role="status"
        aria-label={`Liveness: ${label}`}
        className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${livenessDotClass(agent.liveness)}`}
      />

      {/* Title + task ID */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">{agent.title}</span>
        {agent.taskId && (
          <span className="text-xs text-muted-foreground">{agent.taskId}</span>
        )}
      </div>

      {/* PR badge */}
      {agent.prNumber != null && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
          #{agent.prNumber}
          {agent.prStatus ? ` (${agent.prStatus})` : ""}
        </span>
      )}

      {/* Last activity */}
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
        {formatRelative(agent.lastActivityAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column header
// ---------------------------------------------------------------------------

function AgentsTableHeader() {
  return (
    <div className="flex items-center gap-3 py-1 mb-0.5 border-b border-border">
      {/* dot placeholder */}
      <span className="inline-block h-2 w-2 flex-shrink-0" />
      <span className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Session
      </span>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0">
        PR
      </span>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 tabular-nums">
        Activity
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query
// ---------------------------------------------------------------------------

export function Agents() {
  const query = useQuery<AgentsWidgetData, Error>({
    queryKey: ["agents"],
    queryFn: fetchAgentsData,
    staleTime: 30_000,
    refetchInterval: 5_000,
  });

  // Error state (network failure, non-200, JSON parse error)
  if (query.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Agents</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load agents: {query.error.message}</p>
        </CardContent>
      </Card>
    );
  }

  // Loading state (no data yet, not an error)
  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Agents</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;

  // Degraded state (server-reported)
  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Agents</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  const agents = data.payload.agents ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Agents</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active agents</p>
        ) : (
          <div>
            <AgentsTableHeader />
            {agents.map((agent) => (
              <AgentRowItem key={agent.sessionId} agent={agent} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
