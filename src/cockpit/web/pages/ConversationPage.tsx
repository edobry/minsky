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
 * Header label (mt#2770, corrected by mt#3343): the heading shows the
 * conversation's OWN server-computed label, read from the same
 * `GET /api/conversation/:id/overview` payload + `["conversation-overview", id]`
 * query key `RunDetail` already fetches — so there is one shared cache entry,
 * not a second request.
 *
 * mt#2770 originally derived this label by searching the context-inspector
 * widget's TOP-50 picker window for this conversation's own id and falling back
 * to the bare uuid on a miss. A conversation outside that window therefore had
 * no name at all, and since the mono sub-line below is also the raw id, the page
 * rendered the same 36-character uuid twice with nothing identifying the run
 * (mt#3343; universal in practice because mt#3342's NULL-`started_at` rows
 * crowd the window). A detail page must be able to name ITSELF — it must not
 * depend on appearing in a paginated list, which is the same discipline
 * `WorkspaceDetailPage` already follows for its breadcrumb (mt#2967).
 *
 * Tab hygiene (mt#2769): a genuinely unresolvable conversation id (404, not
 * `wrong_id_space`) reports up via `ConversationView`'s `onNotFound` (forwarded
 * through `RunDetail`), which this page maps to `markTabError` — the tab-strip
 * entry shows an error chip for this visit and is excluded from persistence,
 * so it does not resurrect as a dead tab on the next reload.
 *
 * Presence chrome (mt#3261, split by mt#3344): the header carries mt#3130's
 * single always-visible Presence VALUE, read from
 * `GET /api/conversation/:id/presence`, and passes it into `RunDetail`'s
 * pinned `chrome` slot so it stays on screen at any scroll depth. mt#3130
 * placement decision (1) put the Activity sub-line there too; mt#3344 narrows
 * that — Activity now renders at the transcript's tail via `conversationTail`,
 * because an operator reading "Running <tool>" is following the live edge at
 * the bottom of the transcript, not the page chrome at the top. The presence
 * VALUE stays in the chrome: it is a property of the conversation, not of the
 * transcript, and must be readable from the Overview and Context tabs too.
 */
import { useParams, useLocation } from "react-router-dom";
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RunDetail,
  fetchConversationOverview,
  type ConversationOverviewPayload,
} from "../widgets/RunDetail";
import {
  ConversationPresenceChip,
  ConversationActivityLine,
} from "../components/ConversationPresenceChip";
import { useTabs } from "../lib/tabs";
import type { ConversationId } from "@minsky/domain/ids";

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const { markTabError } = useTabs();

  const handleNotFound = useCallback(() => {
    markTabError(pathname);
  }, [markTabError, pathname]);

  // Same query key + options as `RunDetail`'s own `conversationOverviewQuery`
  // (mt#3343): TanStack Query dedupes identical keys under one QueryClient, so
  // reading the label here costs no additional network request. Mirrors
  // `WorkspaceDetailPage.tsx`'s breadcrumb-displayId pattern (mt#2967).
  const overviewQuery = useQuery<ConversationOverviewPayload, Error>({
    queryKey: ["conversation-overview", id],
    queryFn: () => fetchConversationOverview(id as ConversationId),
    staleTime: 30_000,
    retry: 1,
    enabled: Boolean(id),
  });

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No conversation id in the URL.</div>;
  }

  // Falls back to the bare id only while the query is in flight or when the
  // conversation is genuinely unresolvable (404) — the server's own tier-4
  // fallback covers every resolvable conversation, so this is not the routine
  // path it used to be.
  const label = overviewQuery.data?.label ?? id;

  // Never render the id twice (mt#3343). The mono sub-line exists to expose the
  // raw id for copy/reference ALONGSIDE a human name; when the heading IS the
  // raw id, repeating it verbatim underneath adds nothing and reads as a bug.
  const showIdSubline = label !== id;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <RunDetail
        key={id}
        id={id}
        keySpace="conversation"
        onConversationNotFound={handleNotFound}
        chrome={
          <div className="flex flex-col gap-0.5">
            <h1 className="truncate text-lg font-semibold" title={label}>
              {label}
            </h1>
            {showIdSubline && (
              <span className="font-mono text-xs text-muted-foreground" title={id}>
                {id}
              </span>
            )}
            <ConversationPresenceChip conversationId={id} />
          </div>
        }
        conversationTail={<ConversationActivityLine conversationId={id} />}
      />
    </div>
  );
}
