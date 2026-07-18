/**
 * AsksPage — the decision inbox (/asks, mt#2882).
 *
 * Console altitude (/product-thinking): every pending ask is answerable FROM
 * THIS SURFACE — inline typed actions (the ask's own options, or
 * Approve/Deny, plus Defer) reuse the same resolve/defer endpoints the
 * detail page drives; row expansion shows the full question + option
 * descriptions so the common decision needs no navigation. Escalate and the
 * full context live on /ask/:id (the "open" affordance per row).
 *
 * Unit-of-work bundles (agent-inbox pattern, mt#2882): asks sharing kind +
 * work anchor (parentTaskId — mt#N / gh#N) render as ONE decision group with
 * its members stacked inside, not N look-alike micro-approvals. Grouping is
 * render-side only (lib/ask-groups.ts); producer-side hygiene stays with the
 * ask lifecycle (mt#1034).
 *
 * Queue health (ISA-18.2 standing-alarm discipline): asks open >24h are
 * STANDING — marked per row and counted against a budget of
 * STANDING_ASK_BUDGET; an over-budget queue shows a warning chip. Default
 * order is needs-me (kind priority, then oldest first — accumulated debt on
 * top), matching the home triage band.
 *
 * Self-fetching via TanStack Query against GET /api/asks (shared ["asks"]
 * cache with the home TriageBand).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "../components/ui/button";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useListControls, type SortDir } from "../lib/useListControls";
import { formatRequestor, formatRequestorOption } from "../lib/entity-labels";
import {
  groupAsks,
  inlineActionsFor,
  consequenceSnippet,
  isStanding,
  STANDING_ASK_BUDGET,
  type AskGroup,
} from "../lib/ask-groups";
import { cn } from "../lib/utils";
import {
  fetchAsks,
  resolveAsk,
  deferAsk,
  composeResolvePayload,
  formatRelative,
  formatDeadlineRemaining,
  kindStyle,
  KIND_PRIORITY,
  type AskItem,
  type AsksListResponse,
} from "../widgets/AskDetail";

// ---------------------------------------------------------------------------
// Filter / sort types — filters apply to ASKS, sort + pagination to GROUPS.
// ---------------------------------------------------------------------------

type SortKey = "priority" | "age" | "kind";

type Filters = {
  kind: string;
  requestor: string;
  cohort: string;
};

// ---------------------------------------------------------------------------
// Inline action mutations
// ---------------------------------------------------------------------------

function useInlineAskActions() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const settle = () => {
    setPendingId(null);
    void queryClient.invalidateQueries({ queryKey: ["asks"] });
    void queryClient.invalidateQueries({ queryKey: ["attention"] });
  };

  const resolveMutation = useMutation({
    mutationFn: ({ ask, optionLetter }: { ask: AskItem; optionLetter: string }) =>
      resolveAsk(ask.id, composeResolvePayload(ask, optionLetter, "inbox")),
    onMutate: ({ ask }) => setPendingId(ask.id),
    onSettled: settle,
  });

  const deferMutation = useMutation({
    mutationFn: (askId: string) => deferAsk(askId),
    onMutate: (askId) => setPendingId(askId),
    onSettled: settle,
  });

  return { resolveMutation, deferMutation, pendingId };
}

type InlineAskActions = ReturnType<typeof useInlineAskActions>;

// ---------------------------------------------------------------------------
// Requestor display cell (mt#2883)
// ---------------------------------------------------------------------------

function RequestorCell({
  requestor,
  parentTaskId,
}: {
  requestor: string;
  parentTaskId: string | null;
}) {
  const display = formatRequestor(requestor, parentTaskId);
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground flex-shrink-0 max-w-[140px] truncate hidden sm:block",
        display.isAscribed ? "italic" : "font-mono"
      )}
      title={display.raw}
    >
      {display.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One ask row — badge, title, inline actions, expandable question.
// ---------------------------------------------------------------------------

function AskRow({
  ask,
  actions,
  inGroup,
}: {
  ask: AskItem;
  actions: InlineAskActions;
  inGroup: boolean;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";
  const standing = isStanding(ask);
  const pending = actions.pendingId === ask.id;
  const inline = inlineActionsFor(ask);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card transition-colors",
        inGroup && "border-border/60",
        pending && "opacity-50 pointer-events-none"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse question" : "Expand question"}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          {!inGroup && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}
            >
              {ks.priority}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {ask.title}
          </span>
        </button>

        <RequestorCell requestor={ask.requestor} parentTaskId={ask.parentTaskId ?? null} />

        {/* Per-row standing marker (mt#2917): de-emphasized to a plain dot +
            label rather than a filled pill — a queue can carry a dozen
            standing rows at once, and a repeated loud chip on every one of
            them drowns the exceptional signal. The queue-level "N standing"
            chip (header, GroupCard) stays a filled pill — that's the ONE
            aggregate worth calling out loudly. */}
        {standing && (
          <span
            className="flex flex-shrink-0 items-center gap-1 text-xs text-warn-amber tabular-nums"
            title={`Open since ${ask.createdAt} — standing (>24h)`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn-amber" aria-hidden />
            standing
          </span>
        )}
        {deadlineStr && (
          <span
            className={`text-xs flex-shrink-0 tabular-nums ${
              isOverdue ? "text-destructive font-medium" : "text-muted-foreground"
            }`}
          >
            {deadlineStr}
          </span>
        )}
        <span className="w-14 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatRelative(ask.createdAt)}
        </span>

        {/* Inline actions — answer from here (act-here over navigate-away). */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {inline.map((a) =>
            a.action === "resolve" ? (
              <Button
                key={a.label}
                size="sm"
                variant={a.optionLetter === "A" ? "default" : "outline"}
                className="h-6 px-2 text-xs"
                disabled={pending}
                title={
                  ask.options?.[(a.optionLetter ?? "A").charCodeAt(0) - 65]?.description ??
                  undefined
                }
                onClick={() =>
                  actions.resolveMutation.mutate({ ask, optionLetter: a.optionLetter ?? "A" })
                }
              >
                {a.label}
              </Button>
            ) : (
              <Button
                key={a.label}
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                disabled={pending}
                onClick={() => actions.deferMutation.mutate(ask.id)}
              >
                {a.label}
              </Button>
            )
          )}
          <button
            type="button"
            aria-label={`Open ask ${ask.id}`}
            title="Full detail (context, escalate)"
            onClick={() => navigate(`/ask/${encodeURIComponent(ask.id)}`)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Collapsed consequence line (PR #2027 R2): the question's lead
          sentence — what this decision DOES — readable without expansion. */}
      {!expanded && (
        <p className="truncate px-9 pb-1.5 text-xs text-muted-foreground">
          {consequenceSnippet(ask.question)}
        </p>
      )}

      {/* Expanded: the full question + option descriptions — the decision is
          readable here, without opening the detail page. */}
      {expanded && (
        <div className="border-t border-border/60 px-9 py-2 text-sm text-muted-foreground">
          <p className="whitespace-pre-wrap">{ask.question}</p>
          {ask.options && ask.options.length > 0 && (
            <ul className="mt-2 space-y-1">
              {ask.options.map((opt, i) => (
                <li key={`${opt.label}-${i}`} className="text-xs">
                  <span className="font-medium text-foreground">
                    {String.fromCharCode(65 + i)}. {opt.label}
                  </span>
                  {opt.description && <span className="ml-1">— {opt.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A decision group — one bundle per unit of work.
// ---------------------------------------------------------------------------

function GroupCard({ group, actions }: { group: AskGroup; actions: InlineAskActions }) {
  const single = group.asks.length === 1;
  const first = group.asks[0];
  if (single && first) {
    return <AskRow ask={first} actions={actions} inGroup={false} />;
  }
  const ks = kindStyle(group.kind);
  return (
    <div className="rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}
        >
          {ks.priority}
        </span>
        <span className="text-sm font-medium text-foreground">
          {group.asks.length} × {group.kind}
        </span>
        {group.subject && (
          <span className="font-mono text-xs text-muted-foreground">{group.subject}</span>
        )}
        {group.standingCount > 0 && (
          <span className="rounded bg-warn-amber/30 px-1.5 py-0.5 text-xs text-foreground tabular-nums">
            {group.standingCount} standing
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          oldest {formatRelative(group.oldestCreatedAt)}
        </span>
      </div>
      <div className="space-y-1 border-t border-border/60 p-2">
        {group.asks.map((ask) => (
          <AskRow key={ask.id} ask={ask} actions={actions} inGroup />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AsksPage() {
  const actions = useInlineAskActions();

  const query = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const asks = query.data?.asks ?? [];

  const uniqueKinds = [...new Set(asks.map((a) => a.kind))].sort();
  const uniqueRequestors = [...new Set(asks.map((a) => a.requestor))].sort();
  const uniqueCohorts = [...new Set(asks.map((a) => a.windowKey ?? "(none)"))].sort();
  const standingTotal = asks.filter((a) => isStanding(a)).length;
  const overBudget = standingTotal > STANDING_ASK_BUDGET;

  // useListControls supplies filter state + Clear only. Pagination is
  // deliberately unused (PR #2027 R1): grouping must consume the FULL
  // filtered set — paginating asks before bundling drops items and can split
  // a unit-of-work across pages. The queue is small by design (the standing
  // budget keeps it so); if it ever needs paging, page over GROUPS.
  const controls = useListControls<AskItem, "age", Filters>({
    items: asks,
    defaultPageSize: 25, // unused — see filteredAsks below
    defaultSortKey: "age",
    defaultSortDir: "asc",
    defaultFilters: { kind: "all", requestor: "all", cohort: "all" },
    prefix: "asks",
    filterFn: () => true, // unused — see filteredAsks below
    sortFn: () => 0,
  });

  const { filters } = controls;
  const filteredAsks = asks.filter((item) => {
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (filters.requestor !== "all" && item.requestor !== filters.requestor) return false;
    if (filters.cohort !== "all" && (item.windowKey ?? "(none)") !== filters.cohort) return false;
    return true;
  });

  const [groupSort, setGroupSort] = useState<`${SortKey}_${SortDir}`>("priority_asc");
  const groups = groupAsks(filteredAsks);
  const [sortKey, sortDir] = groupSort.split("_") as [SortKey, SortDir];
  const mult = sortDir === "asc" ? 1 : -1;
  groups.sort((a, b) => {
    switch (sortKey) {
      case "priority": {
        const diff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
        if (diff !== 0) return diff * mult;
        // Needs-me tiebreak: oldest accumulated debt first.
        return new Date(a.oldestCreatedAt).getTime() - new Date(b.oldestCreatedAt).getTime();
      }
      case "age":
        return (
          (new Date(a.oldestCreatedAt).getTime() - new Date(b.oldestCreatedAt).getTime()) * mult
        );
      case "kind":
        return a.kind.localeCompare(b.kind) * mult;
      default:
        return 0;
    }
  });

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <ErrorState prefix="Failed to load asks" error={query.error} />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      {/* Header + controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-h1 font-semibold text-foreground">
          Asks
          {filteredAsks.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {filteredAsks.length} pending · {groups.length} decisions
            </span>
          )}
          {standingTotal > 0 && (
            <span
              className={cn(
                "ml-2 rounded px-1.5 py-0.5 text-xs tabular-nums",
                overBudget
                  ? "bg-warn-amber/40 text-foreground"
                  : "bg-muted text-muted-foreground"
              )}
              title={`Asks open >24h. Standing budget: ${STANDING_ASK_BUDGET} (ISA-18.2 standing-alarm ceiling) — above it the QUEUE is unhealthy, independent of any single ask.`}
            >
              {standingTotal} standing{overBudget ? ` / budget ${STANDING_ASK_BUDGET}` : ""}
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2">
          <select
            value={controls.filters.kind}
            onChange={(e) => controls.setFilter("kind", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by kind"
          >
            <option value="all">All kinds</option>
            {uniqueKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <select
            value={controls.filters.requestor}
            onChange={(e) => controls.setFilter("requestor", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by requestor"
          >
            <option value="all">All requestors</option>
            {uniqueRequestors.map((r) => {
              const label = formatRequestorOption(r);
              return (
                <option key={r} value={r}>
                  {label.length > 30 ? label.slice(0, 30) + "..." : label}
                </option>
              );
            })}
          </select>

          <select
            value={controls.filters.cohort}
            onChange={(e) => controls.setFilter("cohort", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by cohort"
          >
            <option value="all">All cohorts</option>
            {uniqueCohorts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={groupSort}
            onChange={(e) => setGroupSort(e.target.value as `${SortKey}_${SortDir}`)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Sort order"
          >
            <option value="priority_asc">Needs me first</option>
            <option value="age_asc">Oldest first</option>
            <option value="age_desc">Newest first</option>
            <option value="kind_asc">Kind (A-Z)</option>
          </select>

          {controls.hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={controls.clearFilters} className="text-xs">
              Clear
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState message="Loading..." variant="page" />
      ) : groups.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium text-foreground">No pending asks</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {controls.hasActiveFilters
              ? "No asks match your current filters."
              : "All clear — nothing needs your attention."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {groups.map((group) => (
            <GroupCard key={group.key} group={group} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}