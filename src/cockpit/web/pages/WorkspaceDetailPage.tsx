/**
 * WorkspaceDetailPage — detail view route for /agents/:id (mt#1919, renamed
 * from SessionDetailPage per ADR-022 stage 1, mt#2686).
 *
 * Thin page wrapper: breadcrumb chrome + the shared tabbed `RunDetail` body
 * (mt#2768 — Overview/Conversation/Context tabs on one shared detail
 * surface). `RunDetail` owns all data-fetching and tab-state; this page only
 * supplies the workspace-keyed `id` and page-level chrome. The breadcrumb goes
 * IN through `RunDetail`'s `chrome` slot rather than beside it (mt#3344), so it
 * pins together with the tab strip while the transcript scrolls.
 *
 * Distinct from /conversation/:id (ConversationPage), which is keyed by the
 * harness agentSessionId and lands on the Conversation tab by default.
 */
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RunDetail, fetchWorkspaceDetail, type WorkspaceDetailPayload } from "../widgets/RunDetail";
import { CopyId } from "../components/CopyId";
import {
  ConversationPresenceChip,
  ConversationActivityLine,
} from "../components/ConversationPresenceChip";
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
  // mt#3554 — the pinned title. `taskTitle` is what the Agents list shows for
  // this row, so the two surfaces name the run identically.
  const title = detailQuery.data?.session.taskTitle ?? null;

  return (
    <div className="p-4 w-full max-w-4xl flex flex-col gap-6">
      {sessionId ? (
        <RunDetail
          key={sessionId}
          id={sessionId}
          keySpace="workspace"
          chrome={
            <div className="flex flex-col gap-0.5">
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
              {/* mt#3554 — the pinned region used to hold the breadcrumb alone,
                  so scrolling deep into a transcript left nothing on screen
                  naming the run. `taskTitle` is the same label the Agents list
                  shows for this row; omitted entirely (not rendered as a
                  placeholder) for an untasked workspace, whose breadcrumb short
                  id is then the identifying line. */}
              {title && (
                <h1 className="truncate text-lg font-semibold" title={title}>
                  {title}
                </h1>
              )}
            </div>
          }
          renderActiveConversationChrome={(conversationId) => (
            <div className="flex items-center gap-3">
              <ConversationPresenceChip conversationId={conversationId} />
              {/* mt#3554 — the workspace's route to a film. Deliberately a link
                  OUT to the conversation rather than a workspace-keyed `film`
                  tab: mt#3468 retired `/agents/:id/film` because a film replays
                  a CONVERSATION and a workspace address names no particular
                  one, and named "through the conversation it links to" as the
                  honest path. This is that path. */}
              <Link
                to={`/conversation/${encodeURIComponent(conversationId)}/film`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Film →
              </Link>
            </div>
          )}
          renderActiveConversationTail={(conversationId) => (
            <ConversationActivityLine conversationId={conversationId} />
          )}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No workspace ID in URL.</p>
      )}
    </div>
  );
}
