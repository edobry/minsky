/**
 * ConversationOverviewPanel (mt#2792) — enrichment beneath the conversation
 * Overview tab's existing body (`WorkspaceOverviewBody` / `ConversationMetaBody`
 * in `RunDetail.tsx`).
 *
 * Renders, where derivable, fields the Overview tab did not previously show:
 *   - a link to the bound workspace session (`/agents/:id`), when one resolved
 *   - duration (startedAt -> endedAt, falling back to last-activity)
 *   - related task(s) / PR(s) — regex-extracted refs on the `agent_transcripts`
 *     row (mt#1329 metadata-extractor), entity-linked via the mt#2550 codec
 *   - tool-call count + top-N by-tool breakdown + tool-error count, and a
 *     first-user-prompt / last-assistant-message snippet — computed CLIENT-SIDE
 *     from the same snapshot the Conversation tab fetches (shared query key,
 *     `lib/conversation-snapshot.ts`), so viewing Overview after Conversation
 *     costs no extra network round trip.
 *
 * Every field degrades gracefully: absent/unfetchable data renders NOTHING for
 * that field (no empty labels, no dashes) — see mt#2792 spec success criterion.
 *
 * @see mt#2792 — this task
 * @see src/cockpit/web/widgets/RunDetail.tsx — the Overview tab this panel extends
 * @see src/cockpit/web/lib/conversation-stats.ts — the pure stats computation
 * @see src/cockpit/web/lib/entity-codec.ts — the mt#2550 (type,id)->path codec
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";
import type { ConversationId } from "@minsky/domain/ids";
import { LoadingState } from "../components/LoadingState";
import { entityToPath } from "../lib/entity-codec";
import { shortenId } from "../lib/format";
import { formatDurationShort } from "../lib/format-duration";
import { computeConversationStats, computeDurationMs } from "../lib/conversation-stats";
import { fetchSnapshot, snapshotQueryKey, snapshotRetry } from "../lib/conversation-snapshot";
import { MetaItem, type ConversationOverviewPayload, type WorkspaceOverviewFields } from "./RunDetail";

const LINK_CLASS = "text-primary hover:underline";
const CHIP_CLASS =
  "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary hover:underline";

// ---------------------------------------------------------------------------
// Workspace link + duration
// ---------------------------------------------------------------------------

function WorkspaceAndDuration({
  workspace,
  durationMs,
}: {
  workspace: WorkspaceOverviewFields | null;
  durationMs: number | null;
}) {
  if (!workspace && durationMs === null) return null;
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
      {workspace && (
        <MetaItem label="Workspace">
          <Link
            to={entityToPath("session", workspace.session.sessionId)}
            className={`font-mono text-xs ${LINK_CLASS}`}
          >
            {shortenId(workspace.session.sessionId, 12)}
          </Link>
        </MetaItem>
      )}
      {durationMs !== null && <MetaItem label="Duration">{formatDurationShort(durationMs)}</MetaItem>}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Related task(s) / PR(s)
// ---------------------------------------------------------------------------

function RelatedEntities({
  relatedTaskIds,
  relatedPrNumbers,
}: {
  relatedTaskIds: string[];
  relatedPrNumbers: string[];
}) {
  if (relatedTaskIds.length === 0 && relatedPrNumbers.length === 0) return null;
  return (
    <section aria-label="Related">
      <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Related</h3>
      <div className="flex flex-wrap gap-1.5">
        {relatedTaskIds.map((taskId) => (
          <Link key={`task-${taskId}`} to={entityToPath("task", taskId)} className={CHIP_CLASS}>
            {taskId}
          </Link>
        ))}
        {relatedPrNumbers.map((prNumber) => (
          <Link
            key={`pr-${prNumber}`}
            to={entityToPath("changeset", prNumber)}
            className={CHIP_CLASS}
          >
            PR #{prNumber}
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tool activity + snippet (self-fetches the snapshot, shared query key)
// ---------------------------------------------------------------------------

function ConversationActivity({ agentSessionId }: { agentSessionId: ConversationId }) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(agentSessionId),
    queryFn: () => fetchSnapshot(agentSessionId),
    staleTime: 30_000,
    retry: snapshotRetry,
  });

  if (query.isPending) return <LoadingState message="Loading activity…" />;
  // Degrade gracefully — a snapshot fetch failure (no transcript yet, wrong
  // id space, etc.) must not block the rest of the Overview panel. The
  // Conversation tab already surfaces the real error for this id.
  if (query.isError || !query.data) return null;

  const stats = computeConversationStats(query.data.blocks);
  const snippet = stats.lastAssistantMessageSnippet ?? stats.firstUserPromptSnippet;
  const snippetLabel = stats.lastAssistantMessageSnippet ? "Last assistant message" : "First user prompt";

  if (stats.toolCallCount === 0 && !snippet) return null;

  return (
    <div className="flex flex-col gap-3">
      {stats.toolCallCount > 0 && (
        <section aria-label="Tool activity">
          <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Tool activity</h3>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>
              {stats.toolCallCount} tool call{stats.toolCallCount === 1 ? "" : "s"}
            </span>
            {stats.toolErrorCount > 0 && (
              <span className="text-destructive">
                {stats.toolErrorCount} error{stats.toolErrorCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {stats.toolBreakdown.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {stats.toolBreakdown.map((entry) => (
                <li
                  key={entry.name}
                  className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                >
                  <span className="font-mono truncate">{entry.name}</span>
                  <span className="tabular-nums flex-shrink-0">{entry.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {snippet && (
        <section aria-label={snippetLabel}>
          <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{snippetLabel}</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{snippet}</p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface ConversationOverviewPanelProps {
  agentSessionId: ConversationId;
  conversationMeta: ConversationOverviewPayload["conversationMeta"];
  workspace: WorkspaceOverviewFields | null;
}

export function ConversationOverviewPanel({
  agentSessionId,
  conversationMeta,
  workspace,
}: ConversationOverviewPanelProps) {
  const durationMs = computeDurationMs(
    conversationMeta.startedAt,
    conversationMeta.endedAt ?? conversationMeta.lastActivityAt
  );

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceAndDuration workspace={workspace} durationMs={durationMs} />
      <RelatedEntities
        relatedTaskIds={conversationMeta.relatedTaskIds}
        relatedPrNumbers={conversationMeta.relatedPrNumbers}
      />
      <ConversationActivity agentSessionId={agentSessionId} />
    </div>
  );
}
