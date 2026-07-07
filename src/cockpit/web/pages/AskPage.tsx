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
 * Data: the same GET /api/asks list query the list page uses (shared query
 * key → cache hit on row click); the ask is found by id. A missing id —
 * resolved ask, expired deep link — renders a graceful empty state.
 */
import { useParams, useNavigate, Link, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AskDetail,
  fetchAsks,
  resolveAsk,
  deferAsk,
  escalateAsk,
  type AskItem,
  type AsksListResponse,
} from "../widgets/AskDetail";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useState } from "react";
import { shortenId } from "../lib/format";
import { useTabs } from "../lib/tabs";

export function AskPage() {
  const { id } = useParams<{ id: string }>();
  const askId = id ?? "";
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { closeTab } = useTabs();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState(false);

  const query = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
  });

  const asks = query.data?.asks ?? [];
  const ask = asks.find((a) => a.id === askId) ?? null;

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

      {query.isError ? (
        <ErrorState prefix="Failed to load ask" error={query.error} />
      ) : query.isPending ? (
        <LoadingState message="Loading ask…" />
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
        <div className="flex flex-col gap-1 py-8 text-center">
          <p className="text-sm text-muted-foreground">This ask is no longer pending.</p>
          <p className="text-xs text-muted-foreground/70">
            It may have been resolved, expired, or the link is stale.
          </p>
        </div>
      )}
    </div>
  );
}
