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
  type AskState,
  type AsksListResponse,
} from "../widgets/AskDetail";
import { isTerminal } from "@minsky/domain/ask/state-machine";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useState } from "react";
import { shortenId } from "../lib/format";
import { useTabs } from "../lib/tabs";

/** Human phrasing for a terminal state. Terminal-vs-open classification itself
 * comes from the domain state machine's `isTerminal` (the single source of
 * truth — note "responded" is NOT terminal: the response is recorded but the
 * ask has not closed, so it still renders the actionable detail view).
 */
function terminalLabel(state: AskState): string {
  if (state === "expired") return "expired";
  if (state === "cancelled") return "cancelled";
  return "resolved";
}

export function AskPage() {
  const { id } = useParams<{ id: string }>();
  const askId = id ?? "";
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { closeTab } = useTabs();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState(false);

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

  /** Consumable-entity settle: close this ask's tab, landing on /asks. */
  function settle() {
    setResolving(false);
    void queryClient.invalidateQueries({ queryKey: ["asks"] });
    void queryClient.invalidateQueries({ queryKey: ["attention"] });
    closeTab(pathname, { navigateTo: "/asks" });
  }

  const resolveMutation = useMutation({
    mutationFn: async ({ target, optionLetter }: { target: AskItem; optionLetter: string }) => {
      const letterIndex = optionLetter.charCodeAt(0) - "A".charCodeAt(0);
      let payloadValue: unknown;
      if (target.options && target.options.length > 0) {
        const option = target.options[letterIndex];
        payloadValue = { option: String(option?.value ?? ""), chosen: String(option?.value ?? "") };
      } else {
        payloadValue = { approved: optionLetter === "A" };
      }
      await resolveAsk(target.id, {
        responder: "operator",
        payload: payloadValue,
        attentionCost: { transport: "inbox", resolvedIn: "inbox" },
      });
    },
    onMutate: () => setResolving(true),
    onSettled: settle,
  });

  const deferMutation = useMutation({
    mutationFn: (targetId: string) => deferAsk(targetId),
    onMutate: () => setResolving(true),
    onSettled: settle,
  });

  const escalateMutation = useMutation({
    mutationFn: (targetId: string) => escalateAsk(targetId),
    onMutate: () => setResolving(true),
    onSettled: settle,
  });

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
        <span className="font-mono text-foreground" title={askId}>
          {shortenId(askId)}
        </span>
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
        <div className="flex flex-col gap-2 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            This ask was {terminalLabel(ask.state)}.
          </p>
          <p className="text-xs text-muted-foreground/70">{ask.title}</p>
          {ask.response ? (
            <div className="mx-auto mt-2 max-w-lg text-left">
              <p className="text-xs text-muted-foreground mb-1">
                Response{ask.response.responder ? ` — by ${ask.response.responder}` : ""}
                {ask.respondedAt ? ` on ${new Date(ask.respondedAt).toLocaleString()}` : ""}:
              </p>
              <pre className="text-xs bg-card border border-border rounded p-2 overflow-x-auto">
                {JSON.stringify(ask.response.payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : ask ? (
        <AskDetail
          ask={ask}
          onResolve={(target, optionLetter) => resolveMutation.mutate({ target, optionLetter })}
          onDefer={(target) => deferMutation.mutate(target.id)}
          onEscalate={(target) => escalateMutation.mutate(target.id)}
          resolving={resolving}
          onClose={() => navigate("/asks")}
        />
      ) : (
        <LoadingState message="Loading ask…" />
      )}
    </div>
  );
}