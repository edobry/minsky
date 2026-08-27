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
 * pinned region via `renderActiveConversationChrome` so it stays on screen at
 * any scroll depth. mt#3130 placement decision (1) put the Activity sub-line
 * there too; mt#3344 narrows that — Activity now renders at the transcript's
 * tail via `renderActiveConversationTail` (both slots became render props in
 * mt#3554, so `/agents/:id` mounts the same two readouts),
 * because an operator reading "Running <tool>" is following the live edge at
 * the bottom of the transcript, not the page chrome at the top. The presence
 * VALUE stays in the chrome: it is a property of the conversation, not of the
 * transcript, and must be readable from the Overview and Context tabs too.
 *
 * ## Two id spaces, one route (mt#3132)
 *
 * This route is the unified conversation surface: it serves a conversation the
 * same way regardless of which pipeline produced it, and it accepts BOTH the
 * harness conversation uuid and a spawn-time session driver local id. Resolution runs
 * through `useConversationAddress` — a registry lookup, never an id-shape guess,
 * because a default local id is uuid-shaped and would pass any shape check (see
 * `../lib/conversation-address.ts`).
 *
 * A session driver that has spawned but not yet emitted its harness `init` frame has
 * NO conversation id to resolve to — nothing to translate the local id into. So
 * "known session driver, no conversation yet" renders as its own state rather than as
 * a 404 or an id-space error.
 *
 * **This route mounts no composer, no send path, and no session driver channel** —
 * mt#3132 Success Criterion 5, read-only by construction. Controllability stays
 * on `/driven/:id` until mt#3095's liveness-refusal gate exists and mt#3325 can
 * mount a composer here safely.
 */
import { useParams, useLocation } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import {
  RunDetail,
  basePathFor,
  fetchConversationOverview,
  tabFromPathname,
  type ConversationOverviewPayload,
} from "../widgets/RunDetail";
import { cn } from "../lib/utils";
import {
  ConversationPresenceChip,
  ConversationActivityLine,
} from "../components/ConversationPresenceChip";
import { Button } from "../components/ui/button";
import { PublishConversationDialog } from "../components/PublishConversationDialog";
import { useTabs } from "../lib/tabs";
import { useConversationAddress } from "../hooks/useConversationAddress";
import {
  isDriverStarting,
  sessionDriverMayStillLink,
  type SessionDriverSummary,
} from "../lib/conversation-address";
import type { ConversationId } from "@minsky/domain/ids";

/**
 * The "known session driver, no conversation yet" body.
 *
 * Renders no presence readout: presence is keyed by conversation id, and there
 * is not one yet. Querying it with the local id would return a wrong-id-space
 * error, which is a caller mistake surfaced as if it were information about the
 * run — the exact confusion `useConversationPresence`'s four-outcome split
 * exists to prevent.
 */
function StartingConversation({ sessionDriver }: { sessionDriver: SessionDriverSummary }) {
  const mayStillLink = sessionDriverMayStillLink(sessionDriver);
  return (
    <div className="rounded border border-border bg-card p-4" data-testid="conversation-starting">
      <p className="text-sm text-foreground">
        {mayStillLink
          ? "Starting — this run has not produced a transcript yet."
          : "This run ended before it produced a transcript."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {mayStillLink
          ? "The view will fill in on its own once the first turn arrives."
          : "There is nothing to read: no conversation was ever recorded for it."}
      </p>
    </div>
  );
}

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const { markTabError } = useTabs();
  const addressState = useConversationAddress(id);
  const address = addressState.status === "resolved" ? addressState.address : null;

  /**
   * Tab pruning waits for the address, but RENDERING does not (mt#3132).
   *
   * Blocking the whole page on the session driver-registry read would put a second
   * request in front of every ordinary conversation load — a regression paid by
   * the common case to serve a rare one. So the conversation path renders
   * optimistically, exactly as before this task, and the registry arrives as a
   * CORRECTION: if it says "session driver, no conversation yet", the body swaps to
   * the starting state below.
   *
   * The one thing that must NOT run optimistically is the 404 handler, because
   * it is destructive — it marks the tab errored and drops it from persistence.
   * A pre-`init` session driver local id 404s here legitimately, and pruning its tab
   * would delete a live run's tab for the crime of being young.
   *
   * So a reported 404 is DEFERRED rather than dropped: it is recorded WITH THE
   * ID IT WAS ABOUT, and acted on once the address settles. Simply ignoring an
   * early 404 would lose the prune permanently — `onNotFound` fires once per
   * fetch, so there is no second chance — and which of the two reads wins is not
   * something this component should have to assume either way.
   *
   * Recording the id is what makes the optimistic render safe. A local-id URL
   * that HAS linked spends its first render fetching under the local id (the
   * fallback below), which legitimately 404s; the address then resolves and the
   * real conversation loads fine. Pruning on that stale 404 would mark a
   * perfectly good tab dead — observed live against a real linked session driver,
   * where the transcript rendered correctly under an errored tab.
   */
  // The conversation to READ. Differs from the URL id only for a local-id
  // arrival that has already linked; falls back to the URL id while the address
  // is still resolving, which is what keeps the common path unblocked.
  const conversationId = address?.kind === "conversation" ? address.conversationId : id;

  const addressResolved = addressState.status === "resolved";
  const [notFoundFor, setNotFoundFor] = useState<string | null>(null);
  // Publish dialog (mt#4024) — state lives here rather than in the button so
  // the dialog mounts outside `RunDetail`'s tab body and survives a tab switch.
  const [publishOpen, setPublishOpen] = useState(false);
  // A ref, so the callback identity stays stable across the id changing.
  const dataIdRef = useRef(conversationId);
  dataIdRef.current = conversationId;
  const handleNotFound = useCallback(() => setNotFoundFor(dataIdRef.current ?? null), []);

  useEffect(() => {
    if (!notFoundFor || !addressResolved) return;
    // A session driver that has not linked a conversation yet has no transcript BY
    // CONSTRUCTION — that 404 is the expected answer, not a dead tab.
    if (address?.kind === "conversation" && notFoundFor === address.conversationId) {
      markTabError(pathname);
    }
    setNotFoundFor(null);
  }, [notFoundFor, addressResolved, address, markTabError, pathname]);

  // Same query key + options as `RunDetail`'s own `conversationOverviewQuery`
  // (mt#3343): TanStack Query dedupes identical keys under one QueryClient, so
  // reading the label here costs no additional network request. Mirrors
  // `WorkspaceDetailPage.tsx`'s breadcrumb-displayId pattern (mt#2967).
  const overviewQuery = useQuery<ConversationOverviewPayload, Error>({
    queryKey: ["conversation-overview", conversationId],
    queryFn: () => fetchConversationOverview(conversationId as ConversationId),
    staleTime: 30_000,
    retry: 1,
    // Skipped once the id is known to address a session driver with no conversation:
    // there is nothing for the overview endpoint to find, and asking anyway
    // would spend a request to be told so.
    enabled: Boolean(conversationId) && !isDriverStarting(address),
  });

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No conversation id in the URL.</div>;
  }

  // The film tab drops the prose column (mt#3461). Every other tab reads as
  // text and wants `max-w-4xl`; the film's stage is the affect-bearing surface
  // that mt#3226 SC 1 and mt#3258 SC 4 twice widened, and a 4xl column would
  // squeeze it back below what those rounds fixed. The `p-4` stays either way —
  // `RunDetail`'s sticky chrome bleeds over it with negative margins.
  const isFilmTab =
    tabFromPathname(pathname, basePathFor("conversation", id), "conversation") === "film";

  const wrapperClass = cn(
    "mx-auto flex w-full flex-col gap-3 p-4",
    isFilmTab ? "max-w-none" : "max-w-4xl"
  );

  if (isDriverStarting(address)) {
    return (
      <div className={wrapperClass}>
        <div className="flex flex-col gap-0.5">
          <h1 className="truncate text-lg font-semibold">Starting…</h1>
          <span className="font-mono text-xs text-muted-foreground" title={address.localId}>
            {address.localId}
          </span>
        </div>
        <StartingConversation sessionDriver={address.sessionDriver} />
      </div>
    );
  }

  // Recomputed rather than reusing `conversationId` above: this is past the
  // `!id` guard, so `id` has narrowed to `string` and the fallback is total.
  const resolved = address?.kind === "conversation" ? address.conversationId : id;

  // Every element of the chrome names the same entity: the CONVERSATION this
  // route resolved to (PR #2502 R1). The heading, its fallback, the id sub-line
  // and the presence readout previously split between the resolved id and the
  // URL address, so a local-id arrival could show one id while reporting
  // presence for another with nothing relating them.
  //
  // The ADDRESS is deliberately not the sub-line: it is already in the URL bar,
  // and the id worth exposing for copy/reference on an entity page is the
  // entity's own. `RunDetail`'s `id`/`key` below stay the address — those build
  // tab paths and remount identity, which must follow what the operator typed.
  //
  // Falls back to the bare id only while the query is in flight or when the
  // conversation is genuinely unresolvable (404) — the server's own tier-4
  // fallback covers every resolvable conversation, so this is not the routine
  // path it used to be.
  const label = overviewQuery.data?.label ?? resolved;

  // Never render the id twice (mt#3343). The mono sub-line exists to expose the
  // raw id for copy/reference ALONGSIDE a human name; when the heading IS the
  // raw id, repeating it verbatim underneath adds nothing and reads as a bug.
  const showIdSubline = label !== resolved;

  return (
    <div className={wrapperClass}>
      <PublishConversationDialog
        conversationId={resolved}
        conversationLabel={label}
        open={publishOpen}
        onOpenChange={setPublishOpen}
      />
      <RunDetail
        key={id}
        id={id}
        keySpace="conversation"
        resolvedConversationId={resolved}
        onConversationNotFound={handleNotFound}
        chrome={
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h1 className="truncate text-lg font-semibold" title={label}>
                {label}
              </h1>
              {showIdSubline && (
                <span className="font-mono text-xs text-muted-foreground" title={resolved}>
                  {resolved}
                </span>
              )}
            </div>
            {/*
              Publish (mt#4024). The affordance opens a confirmation that states
              what becomes readable — it never mints on this click. Placed on
              the conversation's own page because that is where the operator has
              just read the thing they are deciding to publish.
            */}
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              data-testid="share-conversation"
              onClick={() => setPublishOpen(true)}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          </div>
        }
        // mt#3554 — presence and activity moved onto the shared
        // active-conversation slots so `/agents/:id` can mount the same two
        // readouts. Here `activeConversationId` IS `resolved` (the conversation
        // keyspace resolves to its own id), so both render exactly as before.
        renderActiveConversationChrome={(conversationId) => (
          <ConversationPresenceChip conversationId={conversationId} />
        )}
        renderActiveConversationTail={(conversationId) => (
          <ConversationActivityLine conversationId={conversationId} />
        )}
      />
    </div>
  );
}
