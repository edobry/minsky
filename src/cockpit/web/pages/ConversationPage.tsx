/**
 * ConversationPage — `/conversation/:id`, the conversation entity tab's content
 * (mt#2398, renamed from SessionPage per ADR-022 stage 1, mt#2686).
 *
 * Conversations become first-class navigable entities: this route makes a
 * conversation URL-addressable (deep-linkable, palette-jumpable, openable as a
 * tab). The body is mt#2374's layout-agnostic ConversationView (readable
 * chat-thread render of the conversation transcript), originally re-homed
 * from an interim `/conversation` verification host retired by mt#2398; this
 * page's own route happens to reuse the `/conversation/:id` path (mt#2686
 * renamed it from `/session/:id`, which collided with the ADR-022 overload).
 *
 * Richer workspace detail (commits, modified files, PR state, log tail) is
 * mt#1919's scope and lives at the separate `/agents/:id` workspace-detail
 * route; this page deliberately ships the conversation body only.
 *
 * Live (mt#2749): this page has no workspace context at all, so it passes
 * `liveByConversationId` to open the conversation-keyed live-tail channel
 * directly off the URL's agentSessionId — the DB snapshot render below stays
 * unchanged for a completed conversation; live blocks are supplemental
 * appends on top of it, same as the workspace-keyed path.
 *
 * Header label (mt#2770): the heading shows the same derived `label` the run
 * list uses (bound task title -> first-user-prompt snippet -> subagent
 * descriptor -> timestamp·cwd·id fallback), read from the same
 * context-inspector widget payload + TanStack query key the list/picker use
 * (`["context-inspector", "sessions"]`) so there's one shared cache, not a
 * second fetch. The raw id stays visible underneath in monospace for
 * copy/reference. Falls back to the bare id while the query is loading or if
 * this conversation isn't in the top-50 window the widget returns.
 */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ConversationView } from "../widgets/ConversationView";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { extractConversationRows } from "../lib/conversations-source";
import type { ConversationId } from "@minsky/domain/ids";

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();

  const sessionsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    staleTime: 30_000,
    enabled: Boolean(id),
  });

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No conversation id in the URL.</div>;
  }

  // Mint at the URL boundary: /conversation/:id carries a harness agentSessionId (ConversationId).
  const conversationId = id as ConversationId;

  const rows = extractConversationRows(sessionsQuery.data);
  const row = rows.find((r) => r.agentSessionId === id);
  const label = row?.label ?? id;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex flex-col gap-0.5">
        <h1 className="truncate text-lg font-semibold" title={label}>
          {label}
        </h1>
        <span className="font-mono text-xs text-muted-foreground" title={id}>
          {id}
        </span>
      </div>
      <ConversationView sessionId={conversationId} liveByConversationId />
    </div>
  );
}
