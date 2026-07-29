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
import { EntityRef } from "../components/EntityRef";
import { useListControls, type SortDir } from "../lib/useListControls";
import { formatRequestor, formatRequestorOption } from "../lib/entity-labels";
import {
  groupAsks,
  inlineActionsFor,
  consequenceSnippet,
  isStanding,
  STANDING_ASK_BUDGET,
  type AskGroup,
  type InlineAction,
} from "../lib/ask-groups";
import { cn } from "../lib/utils";
import { stripOptionLetterPrefix } from "@minsky/shared/ask-option-label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

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
// Inline action bar — the ask's own typed actions (mt#2882).
//
// Option labels are producer-supplied and routinely 40-60 chars ("[a] GitHub
// Actions migrate-on-merge (recommended)"), so this bar CANNOT share the
// title line: three of them need ~860px against a row width of ~970px, which
// is what pushed Defer and the open-detail affordance off-screen and squeezed
// the title button to zero width (mt#3246). It wraps within its own band
// instead, and each label is width-capped with the full text on hover so one
// pathological label can't reintroduce the overflow.
// ---------------------------------------------------------------------------

const ACTION_LABEL_MAX_W = "max-w-[22rem]";

function InlineActionBar({
  ask,
  actions,
  inline,
  pending,
}: {
  ask: AskItem;
  actions: InlineAskActions;
  inline: InlineAction[];
  pending: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {inline.map((a) =>
        a.action === "resolve" ? (
          <Button
            key={a.label}
            size="sm"
            variant={a.optionLetter === "A" ? "default" : "outline"}
            className={cn("h-6 min-w-0 px-2 text-xs", ACTION_LABEL_MAX_W)}
            disabled={pending}
            title={optionTitle(ask, a)}
            onClick={() =>
              actions.resolveMutation.mutate({ ask, optionLetter: a.optionLetter ?? "A" })
            }
          >
            <span className="truncate">{stripOptionLetterPrefix(a.label)}</span>
          </Button>
        ) : (
          <Button
            key={a.label}
            size="sm"
            variant="ghost"
            className="h-6 flex-shrink-0 px-2 text-xs"
            disabled={pending}
            onClick={() => actions.deferMutation.mutate(ask.id)}
          >
            {a.label}
          </Button>
        )
      )}
    </div>
  );
}

/** Hover text for an option button: the label (which may be truncated on
 *  screen) plus its description when the producer supplied one. Carries the
 *  normalized label, matching what the button shows — the tooltip's job is to
 *  un-truncate the visible text, not to reintroduce a stripped prefix. */
function optionTitle(ask: AskItem, a: InlineAction): string {
  const description = ask.options?.[(a.optionLetter ?? "A").charCodeAt(0) - 65]?.description;
  const label = stripOptionLetterPrefix(a.label);
  return description ? `${label} — ${description}` : label;
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
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
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
          {/* ask#N short id (mt#2965) — absent for legacy pre-backfill asks. */}
          {ask.shortId && (
            <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
              {ask.shortId}
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

        {/* Navigation, not a decision — anchored at the row's right edge so
            full detail is reachable from a fixed position on every row. */}
        <button
          type="button"
          aria-label={`Open ask ${ask.shortId ?? ask.id}`}
          title="Full detail (context, escalate)"
          onClick={() => navigate(`/ask/${encodeURIComponent(ask.id)}`)}
          className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Consequence + actions share one band, consequence FIRST: what the
          decision does is read before it is taken. Short action sets (Approve
          / Deny / Defer) sit on the consequence's line, so a row that already
          fit keeps its two-line height; a long option set wraps beneath it
          rather than overflowing the card (mt#3246). */}
      {!expanded && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pb-2 pl-9">
          {/* Collapsed consequence line (PR #2027 R2): the question's lead
              sentence — what this decision DOES — readable without expansion.
              `basis-64` is what makes the band wrap correctly: flex line
              breaking uses the flex BASE size, so a zero-basis consequence
              would let a 900px action bar share its line and collapse it to an
              ellipsis. Declaring 16rem of wanted width means the actions wrap
              below whenever they'd starve it, while still shrinking (min-w-0)
              on a narrow window. */}
          <p className="min-w-0 flex-1 basis-64 truncate text-xs text-muted-foreground">
            {consequenceSnippet(ask.question)}
          </p>
          <InlineActionBar ask={ask} actions={actions} inline={inline} pending={pending} />
        </div>
      )}

      {/* Expanded: the full question + option descriptions — the decision is
          readable here, without opening the detail page. Actions follow the
          question so the expanded read order is question → options → act. */}
      {expanded && (
        <>
          <div className="border-t border-border/60 px-9 py-2 text-sm text-muted-foreground">
            <p className="whitespace-pre-wrap">{ask.question}</p>
            {ask.options && ask.options.length > 0 && (
              <ul className="mt-2 space-y-1">
                {ask.options.map((opt, i) => (
                  <li key={`${opt.label}-${i}`} className="text-xs">
                    <span className="font-medium text-foreground">
                      {/* This surface renders the letter, so a producer's own
                          "B — " / "[b] " prefix would double it (mt#3253). */}
                      {String.fromCharCode(65 + i)}. {stripOptionLetterPrefix(opt.label)}
                    </span>
                    {opt.description && <span className="ml-1">— {opt.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-3 pb-2 pl-9">
            <InlineActionBar ask={ask} actions={actions} inline={inline} pending={pending} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group subject badge — the shared work anchor for a decision group.
// Mixed id-space (ask-groups.ts `askSubject`): `group.subject` may be an
// `mt#N` Minsky task ref, a `gh#N` GitHub issue ref, or another
// producer-supplied string. <EntityRef> assumes a known RoutableEntityType,
// so only the `mt#N` case is safe to route through it — sniffed with an
// explicit, narrow regex rather than a generic "looks like an id" heuristic.
// Anything else (including `gh#N`) stays plain text: a mis-sniffed `gh#`
// rendered as a broken Minsky link would be worse than not linking at all
// (mt#3187).
// ---------------------------------------------------------------------------
const MT_TASK_SUBJECT_RE = /^mt#\d+$/;

export function GroupSubjectBadge({ subject }: { subject: string }) {
  if (MT_TASK_SUBJECT_RE.test(subject)) {
    return (
      <EntityRef type="task" id={subject} className="text-xs">
        {subject}
      </EntityRef>
    );
  }
  return <span className="font-mono text-xs text-muted-foreground">{subject}</span>;
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}
        >
          {ks.priority}
        </span>
        <span className="truncate text-sm font-medium text-foreground">
          {group.asks.length} × {group.kind}
        </span>
        {group.subject && <GroupSubjectBadge subject={group.subject} />}
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
                overBudget ? "bg-warn-amber/40 text-foreground" : "bg-muted text-muted-foreground"
              )}
              title={`Asks open >24h. Standing budget: ${STANDING_ASK_BUDGET} (ISA-18.2 standing-alarm ceiling) — above it the QUEUE is unhealthy, independent of any single ask.`}
            >
              {standingTotal} standing{overBudget ? ` / budget ${STANDING_ASK_BUDGET}` : ""}
            </span>
          )}
        </h1>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={controls.filters.kind}
            onValueChange={(v) => controls.setFilter("kind", v)}
          >
            <SelectTrigger aria-label="Filter by kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {uniqueKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={controls.filters.requestor}
            onValueChange={(v) => controls.setFilter("requestor", v)}
          >
            <SelectTrigger aria-label="Filter by requestor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All requestors</SelectItem>
              {uniqueRequestors.map((r) => {
                const label = formatRequestorOption(r);
                return (
                  <SelectItem key={r} value={r}>
                    {label.length > 30 ? label.slice(0, 30) + "..." : label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Select
            value={controls.filters.cohort}
            onValueChange={(v) => controls.setFilter("cohort", v)}
          >
            <SelectTrigger aria-label="Filter by cohort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cohorts</SelectItem>
              {uniqueCohorts.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={groupSort}
            onValueChange={(v) => setGroupSort(v as `${SortKey}_${SortDir}`)}
          >
            <SelectTrigger aria-label="Sort order">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="priority_asc">Needs me first</SelectItem>
              <SelectItem value="age_asc">Oldest first</SelectItem>
              <SelectItem value="age_desc">Newest first</SelectItem>
              <SelectItem value="kind_asc">Kind (A-Z)</SelectItem>
            </SelectContent>
          </Select>

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
