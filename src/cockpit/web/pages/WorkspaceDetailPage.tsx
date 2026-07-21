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
import { useQuery } from "@tanstack/react-query";
import { RunDetail, fetchWorkspaceDetail, type WorkspaceDetailPayload } from "../widgets/RunDetail";
import { CopyId } from "../components/CopyId";
import type { WorkspaceId } from "@minsky/domain/ids";

export function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Mint at the URL boundary: /agents/:id carries a Minsky workspace sessionId.
  const sessionId = (id ?? "") as WorkspaceId;

  // displayId=session.shortId (mt#2967): shares the SAME query key as
  // RunDetail's own `workspaceQuery` ([\"workspace-detail\", id]) — TanStack
  // Query dedupes identical keys under one QueryClient, so this does not
  // trigger a second network request. The breadcrumb renders before the
  // fetch settles, so this falls back to the raw uuid from the URL param
  // (sessionId) while loading or for a legacy pre-backfill session.
  const detailQuery = useQuery<WorkspaceDetailPayload, Error>({
    queryKey: ["workspace-detail", sessionId],
    queryFn: () => fetchWorkspaceDetail(sessionId),
    staleTime: 30_000,
    retry: 1,
    enabled: sessionId !== "",
  });
  const shortId = detailQuery.data?.session.shortId ?? undefined;

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
        <CopyId type="session" id={sessionId} displayId={shortId} />
      </nav>

      {sessionId ? (
        <RunDetail key={sessionId} id={sessionId} keySpace="workspace" />
      ) : (
        <p className="text-sm text-muted-foreground">No workspace ID in URL.</p>
      )}
    </div>
  );
}
