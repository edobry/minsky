/**
 * WorkspaceDetailPage — detail view route for /agents/:id (mt#1919, renamed
 * from SessionDetailPage per ADR-022 stage 1, mt#2686).
 *
 * Workspace drill-down: extracts the Minsky workspace sessionId from the URL
 * param and renders the self-fetching WorkspaceDetail widget with a
 * breadcrumb back to the Agents list.
 *
 * Distinct from /conversation/:id (ConversationPage), which is keyed by the
 * harness agentSessionId and renders the conversation transcript.
 * WorkspaceDetail's payload bridges the two via workspace→transcript cwd
 * resolution. The route stays `/agents/:id` (the Agents list/detail pair is a
 * separate naming decision, out of scope for the ADR-022 stage-1 rename) —
 * only the component and its "workspace" framing change here.
 *
 * Live transcript (mt#2232 Rung 1): when the workspace has a resolved
 * agentSessionId and is in a healthy/idle liveness state, an inline
 * ConversationView is shown below the meta section with live-tail enabled —
 * new turns stream in without requiring a full re-fetch.
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { WorkspaceDetail } from "../widgets/WorkspaceDetail";
import { ConversationView } from "../widgets/ConversationView";
import { shortenId } from "../lib/format";
import type { WorkspaceId, ConversationId } from "@minsky/domain/ids";
import type { WorkspaceDetailPayload } from "../widgets/WorkspaceDetail";

async function fetchWorkspaceDetail(sessionId: WorkspaceId): Promise<WorkspaceDetailPayload> {
  const encoded = encodeURIComponent(sessionId);
  const res = await fetch(`/api/agents/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<WorkspaceDetailPayload>;
}

export function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Mint at the URL boundary: /agents/:id carries a Minsky workspace sessionId.
  const sessionId = (id ?? "") as WorkspaceId;

  // Fetch workspace detail to resolve workspace→agentSessionId bridge for live tail.
  const detailQuery = useQuery<WorkspaceDetailPayload, Error>({
    queryKey: ["session-detail", sessionId],
    queryFn: () => fetchWorkspaceDetail(sessionId),
    staleTime: 30_000,
    retry: 1,
    enabled: !!sessionId,
  });

  // Show live transcript when:
  //   1. The detail payload resolved an agentSessionId (conversation bridge)
  //   2. The workspace liveness is healthy or idle (not stale/orphaned)
  const detail = detailQuery.data;
  const agentSessionId = detail?.conversation?.agentSessionId as ConversationId | undefined;
  const liveness = detail?.session?.liveness;
  const showLive =
    !!agentSessionId && (liveness === "healthy" || liveness === "idle");

  // Allow the operator to collapse the inline conversation panel.
  const [conversationOpen, setConversationOpen] = useState(true);

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
        <WorkspaceDetail sessionId={sessionId} />
      ) : (
        <p className="text-sm text-muted-foreground">No workspace ID in URL.</p>
      )}

      {/* Live transcript section (mt#2232 Rung 1) */}
      {showLive && (
        <section aria-label="Live conversation">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-foreground">
              Conversation
              <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse align-middle" aria-label="live" />
            </h2>
            <div className="flex items-center gap-3">
              <Link
                to={`/conversation/${encodeURIComponent(agentSessionId)}`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Full view →
              </Link>
              <button
                type="button"
                onClick={() => setConversationOpen((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={conversationOpen}
              >
                {conversationOpen ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {conversationOpen && (
            <div className="rounded border border-border bg-card p-3 max-h-[60vh] overflow-y-auto">
              <ConversationView
                sessionId={agentSessionId}
                workspaceSessionId={sessionId}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
