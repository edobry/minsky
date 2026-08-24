/**
 * AskPage — detail view route for /ask/:id (mt#2410, mt#2398 PR2).
 *
 * URL-addressable ask detail in the entity-tab pattern (sibling of
 * /tasks/:id, /session/:id, /agents/:id). Retires AsksPage's local-state
 * full-page swap: the ask is addressed by URL and opens as a tab.
 *
 * Settle convention (PR #1668 R1): asks are CONSUMABLE — resolving,
 * deferring, or escalating removes the ask from the pending set, so the
 * entity this tab addresses ceases to exist. On settle the page therefore
 * closes its own tab and returns to /asks (via closeTab's navigateTo), in
 * the same single navigation. This intentionally diverges from durable
 * entities (task / memory / session), whose tabs persist across actions.
 * The Back affordance is plain navigation — the ask was not consumed, so
 * its tab stays in the working set like any other entity tab.
 *
 * Data (mt#2669): a dedicated per-id query (GET /api/asks/:id), seeded from
 * the shared pending-list cache per TanStack's initialData-from-list pattern
 * (initialDataUpdatedAt carries the seed's real age, so a stale seed still
 * refetches). The per-id endpoint returns terminal asks too, so this page
 * distinguishes three end states instead of one generic message: a terminal
 * ask says what happened (with the recorded response), an unknown id says
 * "not found" — and neither verdict renders before a fresh fetch settles.
 * Previously the page resolved the id by find-in-list over the pending
 * snapshot, which declared live asks "no longer pending" whenever the
 * snapshot was empty or stale (deeplink into a fresh cockpit boot).
 */
import { useParams, useNavigate, Link, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AskDetail,
  fetchAskById,
  resolveAsk,
  deferAsk,
  escalateAsk,
  AskNotFoundError,
  type AskItem,
  type AskActionInFlight,
  type AsksListResponse,
  composeResolvePayload,
} from "../widgets/AskDetail";
import { isTerminal } from "@minsky/domain/ask/state-machine";
import { TerminalAskNotice } from "../components/TerminalAskNotice";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { CopyId } from "../components/CopyId";
import { useTabs } from "../lib/tabs";
import { EntityThreadPanel } from "../widgets/EntityThreadPanel";
import {
  ResolveProposalCard,
  RESOLVE_PROPOSAL_SURFACE,
} from "../components/ResolveProposalCard";

export function AskPage() {
  const { id } = useParams<{ id: string }>();
  const askId = id ?? "";
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { closeTab } = useTabs();
  const queryClient = useQueryClient();

  const query = useQuery<AskItem, Error>({
    queryKey: ["asks", askId],
    queryFn: () => fetchAskById(askId),
    enabled: askId !== "",
    initialData: () =>
      queryClient.getQueryData<AsksListResponse>(["asks"])?.asks.find((a) => a.id === askId),
    initialDataUpdatedAt: () => queryClient.getQueryState(["asks"])?.dataUpdatedAt,
  });

  const ask = query.data ?? null;
  const notFound = query.isError && query.error instanceof AskNotFoundError;
  const terminal = ask !== null && isTerminal(ask.state);

  /**
   * Consumable-entity settle: close this ask's tab, landing on /asks.
   *
   * Registered on `onSuccess`, NOT `onSettled` (mt#4503). `onSettled` is
   * documented by TanStack Query as running on both outcomes — "Error or
   * success... doesn't matter!" — so registering the settle there closed the tab
   * and navigated away on a FAILED resolve exactly as it did on a successful
   * one. The ask stayed `suspended` server-side and reappeared in the inbox with
   * no explanation, which reads to an operator as their answer silently not
   * taking. Every non-2xx `/api/asks/:id/resolve` documents — 403, 404, 409, 500,
   * 503 — reached that path.
   */
  function settle() {
    void queryClient.invalidateQueries({ queryKey: ["asks"] });
    void queryClient.invalidateQueries({ queryKey: ["attention"] });
    closeTab(pathname, { navigateTo: "/asks" });
  }

  const resolveMutation = useMutation({
    mutationFn: async ({
      target,
      optionLetter,
      resolvedIn = "inbox",
    }: {
      target: AskItem;
      optionLetter: string;
      /** Which surface the operator acted from. Defaults to the detail page's
       * own option buttons; the mt#3368 thread confirm passes its own value so
       * attention accounting can tell the two apart — and, more importantly, so
       * the payload the proposal card SHOWS is the payload actually sent. */
      resolvedIn?: string;
    }) => {
      // Shared payload composition (mt#2882 R3) — one contract definition in
      // AskDetail serves both the inline inbox actions and this detail page.
      await resolveAsk(target.id, composeResolvePayload(target, optionLetter, resolvedIn));
    },
    onSuccess: settle,
  });

  const deferMutation = useMutation({
    mutationFn: (targetId: string) => deferAsk(targetId),
    onSuccess: settle,
  });

  const escalateMutation = useMutation({
    mutationFn: (targetId: string) => escalateAsk(targetId),
    onSuccess: settle,
  });

  /**
   * Which control is mid-request, derived from the mutations themselves
   * (mt#4503).
   *
   * The page used to carry `const [resolving, setResolving] = useState(false)`
   * driven by each mutation's `onMutate`. That hand-rolled flag is what TanStack
   * Query's `isPending` already is — its guide's first example gates on
   * `mutation.isPending` for exactly this — and rebuilding it cost more than the
   * duplication: a boolean cannot name WHICH option is saving, and a page that
   * never reads `isPending` is a page that never reads `isError` either, which
   * is how the failure branch went unrendered for as long as it did. Reading
   * both off the mutation makes the two states arrive together.
   */
  const acting: AskActionInFlight | null = resolveMutation.isPending
    ? { kind: "resolve", optionLetter: resolveMutation.variables.optionLetter }
    : deferMutation.isPending
      ? { kind: "defer" }
      : escalateMutation.isPending
        ? { kind: "escalate" }
        : null;

  const actionError =
    resolveMutation.error ?? deferMutation.error ?? escalateMutation.error ?? null;

  return (
    <div className="p-4 max-w-3xl mx-auto w-full">
      {/* Breadcrumb */}
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/asks" className="hover:text-foreground transition-colors">
          Asks
        </Link>
        <span aria-hidden="true">/</span>
        {/* displayId=ask.shortId (mt#2965): the breadcrumb renders before the
            per-id fetch settles, so this falls back to the raw uuid from the
            URL param (askId) while loading or for a legacy pre-backfill ask. */}
        <CopyId type="ask" id={askId} displayId={ask?.shortId} />
      </nav>

      {query.isPending ? (
        <LoadingState message="Loading ask…" />
      ) : notFound ? (
        <div className="flex flex-col gap-1 py-8 text-center">
          <p className="text-sm text-muted-foreground">No ask with this id was found.</p>
          <p className="text-xs text-muted-foreground/70">
            The link may be malformed, or the ask belongs to a different workspace.
          </p>
        </div>
      ) : query.isError ? (
        <ErrorState prefix="Failed to load ask" error={query.error} />
      ) : ask && terminal ? (
        // mt#4091 — a terminal ask renders the closure notice AND the full ask
        // body. This branch used to render the notice INSTEAD of <AskDetail>,
        // so resolving an ask destroyed the operator's view of what it had
        // asked: the question, the options with their descriptions, and the
        // contextRefs were all dropped, and the recorded answer showed as a raw
        // JSON payload. The per-id endpoint has always returned this data for a
        // terminal ask (mt#2669) — only the render discarded it.
        //
        // Read-only is a MODE on the same component rather than a second
        // renderer, which is what keeps the closed view from drifting from the
        // pending one — and it satisfies mt#3368's constraint structurally
        // rather than by convention: an already-resolved ask has no action
        // controls to offer, so there is nothing that could write to a closed
        // record. The mt#3215 auto-closed-vs-answered distinction lives in
        // TerminalAskNotice, which owns the closure phrasing.
        <div className="space-y-4">
          <TerminalAskNotice ask={ask} />
          <AskDetail ask={ask} readOnly onClose={() => navigate("/asks")} />
        </div>
      ) : ask ? (
        <AskDetail
          ask={ask}
          onResolve={(target, optionLetter) => resolveMutation.mutate({ target, optionLetter })}
          onDefer={(target) => deferMutation.mutate(target.id)}
          onEscalate={(target) => escalateMutation.mutate(target.id)}
          acting={acting}
          actionError={actionError}
          onClose={() => navigate("/asks")}
        />
      ) : (
        <LoadingState message="Loading ask…" />
      )}

      {/* mt#3365 — the discussion thread renders for BOTH open and terminal
          asks: "what was this asking me?" is a question the principal is at
          least as likely to have about one already closed. */}
      {ask ? (
        <EntityThreadPanel
          entityType="ask"
          entityId={ask.id}
          className="mt-6"
          // mt#3368 — the confirm step. Supplied ONLY for a non-terminal ask:
          // an already-resolved ask has nothing left to confirm, and offering
          // the control there would invite a second write to a closed record.
          // Confirm routes into `resolveMutation`, the SAME path AskDetail's
          // own option buttons use, so there is exactly one resolve path and
          // `composeResolvePayload` remains its only payload source.
          {...(terminal
            ? {}
            : {
                proposalSlot: (proposal) => (
                  <ResolveProposalCard
                    ask={ask}
                    proposal={proposal}
                    disabled={acting !== null}
                    // The card is the acting control only when the in-flight
                    // resolve is the one IT started — `resolvedIn` is what tells
                    // the two apart, and it is already on the mutation's own
                    // variables, so nothing extra has to be tracked.
                    confirming={
                      resolveMutation.isPending &&
                      resolveMutation.variables.resolvedIn === RESOLVE_PROPOSAL_SURFACE
                    }
                    error={resolveMutation.error}
                    onConfirm={(optionLetter) =>
                      resolveMutation.mutate({
                        target: ask,
                        optionLetter,
                        // Must match what ResolveProposalCard rendered — the card
                        // promises "this is what will be recorded", so a
                        // different `resolvedIn` here would make that a lie.
                        resolvedIn: RESOLVE_PROPOSAL_SURFACE,
                      })
                    }
                  />
                ),
              })}
        />
      ) : null}
    </div>
  );
}