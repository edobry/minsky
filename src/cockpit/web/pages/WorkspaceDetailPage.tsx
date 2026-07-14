/**
 * WorkspaceDetailPage — detail view route for /agents/:id (mt#1919, renamed
 * from SessionDetailPage per ADR-022 stage 1, mt#2686).
 *
 * Thin page wrapper: breadcrumb chrome + the shared tabbed `RunDetail` body
 * (mt#2768 — Overview/Conversation/Context tabs on one shared detail
 * surface). `RunDetail` owns all data-fetching and tab-state; this page only
 * supplies the workspace-keyed `id` and page-level chrome.
 *
 * Distinct from /conversation/:id (ConversationPage), which is keyed by the
 * harness agentSessionId and lands on the Conversation tab by default.
 */
import { useParams, Link } from "react-router-dom";
import { RunDetail } from "../widgets/RunDetail";
import { shortenId } from "../lib/format";
import type { WorkspaceId } from "@minsky/domain/ids";

export function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Mint at the URL boundary: /agents/:id carries a Minsky workspace sessionId.
  const sessionId = (id ?? "") as WorkspaceId;

  return (
    <div className="p-4 w-full max-w-4xl flex flex-col gap-6">
      {/* Breadcrumb */}
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
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
        <RunDetail key={sessionId} id={sessionId} keySpace="workspace" />
      ) : (
        <p className="text-sm text-muted-foreground">No workspace ID in URL.</p>
      )}
    </div>
  );
}
