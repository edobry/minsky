/**
 * ConversationPage — `/conversation/:id`, the conversation entity tab's content
 * (mt#2398, renamed from SessionPage per ADR-022 stage 1, mt#2686).
 *
 * Conversations are first-class navigable entities: this route makes a
 * conversation URL-addressable (deep-linkable, palette-jumpable, openable as
 * a tab). Thin page wrapper: label header + the shared tabbed `RunDetail`
 * body (mt#2768 — Overview/Conversation/Context tabs on one shared detail
 * surface), landing on the Conversation tab by default. `RunDetail` owns all
 * data-fetching and tab-state; this page only supplies the conversation-keyed
 * `id` and page-level chrome.
 *
 * Richer workspace detail (commits, PR state) resolves via the REVERSE join
 * (`GET /api/conversation/:id/overview`, mt#2768) and renders on the Overview
 * tab when a workspace exists; a workspace-less run (plain principal
 * conversation) shows conversation metadata instead — see `RunDetail`.
 *
 * Header label (mt#2770): the heading shows the same derived `label` the run
 * list uses (bound task title -> first-user-prompt snippet -> subagent
 * descriptor -> timestamp·cwd·id fallback), read from the same
 * context-inspector widget payload + TanStack query key the list/picker use
 * (`["context-inspector", "sessions"]`) so there's one shared cache, not a
 * second fetch. The raw id stays visible underneath in monospace for
 * copy/reference. Falls back to the bare id while the query is loading or if
 * this conversation isn't in the top-50 window the widget returns.
 *
 * Tab hygiene (mt#2769): a genuinely unresolvable conversation id (404, not
 * `wrong_id_space`) reports up via `ConversationView`'s `onNotFound` (forwarded
 * through `RunDetail`), which this page maps to `markTabError` — the tab-strip
 * entry shows an error chip for this visit and is excluded from persistence,
 * so it does not resurrect as a dead tab on the next reload.
 */
import { useParams, useLocation } from "react-router-dom";
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { RunDetail } from "../widgets/RunDetail";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { extractConversationRows } from "../lib/conversations-source";
import { useTabs } from "../lib/tabs";

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const { markTabError } = useTabs();

  const handleNotFound = useCallback(() => {
    markTabError(pathname);
  }, [markTabError, pathname]);

  const sessionsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    staleTime: 30_000,
    enabled: Boolean(id),
  });

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No conversation id in the URL.</div>;
  }

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
      <RunDetail key={id} id={id} keySpace="conversation" onConversationNotFound={handleNotFound} />
    </div>
  );
}
