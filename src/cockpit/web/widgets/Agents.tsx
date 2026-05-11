import { Card, CardHeader, CardTitle, CardContent } from "../components/Card";

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

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface Props {
  data: WidgetData;
}

// ---------------------------------------------------------------------------
// Liveness helpers
// ---------------------------------------------------------------------------

/** Tailwind dot color for each liveness value */
function livenessDotClass(liveness: AgentRow["liveness"]): string {
  switch (liveness) {
    case "healthy":
      return "bg-green-500";
    case "idle":
      return "bg-amber-400";
    case "stale":
      return "bg-red-500";
    case "orphaned":
      return "bg-gray-400";
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
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      {/* Liveness dot */}
      <span
        className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${livenessDotClass(agent.liveness)}`}
        title={livenessLabel(agent.liveness)}
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
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {formatRelative(agent.lastActivityAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget component
// ---------------------------------------------------------------------------

export function Agents({ data }: Props) {
  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  const payload = data.payload as AgentsPayload;
  const agents = payload.agents ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents</p>
        ) : (
          <div>
            {agents.map((agent) => (
              <AgentRowItem key={agent.sessionId} agent={agent} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
