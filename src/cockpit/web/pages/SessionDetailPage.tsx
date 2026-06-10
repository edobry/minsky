/**
 * SessionDetailPage — detail view route for /agents/:id (mt#1919).
 *
 * Workspace-session drill-down: extracts the Minsky workspace sessionId from
 * the URL param and renders the self-fetching SessionDetail widget with a
 * breadcrumb back to the Agents list.
 *
 * Distinct from /session/:id (SessionPage), which is keyed by the harness
 * agentSessionId and renders the conversation transcript. SessionDetail's
 * payload bridges the two via workspace→transcript cwd resolution.
 */
import { useParams, Link } from "react-router-dom";
import { SessionDetail } from "../widgets/SessionDetail";
import { shortenId } from "../lib/format";

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? "";

  return (
    <div className="p-4 w-full max-w-4xl">
      {/* Breadcrumb */}
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/agents" className="hover:text-foreground transition-colors">
          Agents
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono text-foreground" title={sessionId}>
          {shortenId(sessionId)}
        </span>
      </nav>

      {sessionId ? (
        <SessionDetail sessionId={sessionId} />
      ) : (
        <p className="text-sm text-muted-foreground">No session ID in URL.</p>
      )}
    </div>
  );
}
