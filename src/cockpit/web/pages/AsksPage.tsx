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
 * Resolved view (mt#4092): the page also reaches TERMINAL asks, via a
 * pending/resolved control that defaults to pending. Before it, a resolved ask
 * was reachable only if you already held its deeplink — the per-id route
 * resolves any state (mt#2669) but no list in the product returned one, so an
 * ask closed by accident was gone from the product's navigation entirely. It is
 * a drill-down inside this console rather than a history route: an entity-browse
 * destination on the supervision spine is the IA this page was rebuilt away
 * from, and the operator who lost an ask is already standing here.
 *
 * Self-fetching via TanStack Query against GET /api/asks (shared ["asks"]
 * cache with the home TriageBand; the resolved view uses its own key so the
 * band never sees a terminal ask).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "../components/ui/button";
import { PendingButton } from "../components/PendingButton";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EntityRef } from "../components/EntityRef";
import { Prose } from "../components/Prose";
import { LinkifiedText } from "../components/LinkifiedText";
import { useEntityIndex } from "../lib/use-entity-index";
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
  fetchTerminalAsks,
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

/**
 * Which slice of the queue the page is showing (mt#4092).
 *
 * `resolved` is a drill-down INSIDE this console, not a separate destination: a
 * top-level history route would put an entity-browse page on the supervision
 * spine, and the operator who wants a resolved ask is already standing on the
 * page where it disappeared from.
 */
type AskView = "pending" | "resolved";

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

  /**
   * Refresh the lists so the answered row leaves the inbox.
   *
   * `onSuccess`, not `onSettled` (mt#4503): `onSettled` runs on both outcomes,
   * so a FAILED inline action cleared the pending marker and re-rendered the row
   * exactly as an idle one — the operator's click produced a brief gray-out and
   * then nothing at all, while the ask stayed open server-side.
   */
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["asks"] });
    void queryClient.invalidateQueries({ queryKey: ["attention"] });
  };

  const resolveMutation = useMutation({
    mutationFn: ({ ask, optionLetter }: { ask: AskItem; optionLetter: string }) =>
      resolveAsk(ask.id, composeResolvePayload(ask, optionLetter, "inbox")),
    onSuccess: settle,
  });

  const deferMutation = useMutation({
    mutationFn: (askId: string) => deferAsk(askId),
    onSuccess: settle,
  });

  /**
   * The row whose action is in flight, and which control within it (mt#4503).
   *
   * Derived from the mutations rather than tracked in a `pendingId` state the
   * hook set from `onMutate` — that flag was a hand-rolled `isPending`, and
   * rebuilding it left the sibling `isError` unread, which is the whole reason
   * a failed inline action was invisible.
   */
  /**
   * Each mutation's variables, read ONCE and guarded (PR #3285 R1).
   *
   * `MutationObserverBaseResult.variables` is `TVariables | undefined`; the
   * pending and error VARIANTS narrow it to `TVariables`, which is why the
   * unguarded reads typechecked. The guard does not fix a reachable crash — it
   * removes the dependency on that narrowing holding, since a discriminated
   * union is a library-version detail and nothing here would fail loudly if a
   * future version widened it.
   *
   * Note `deferMutation.variables` is the ask id itself (a bare string), so it
   * needs the same guard for a different reason: `askId: undefined` would make
   * `failure.askId === ask.id` false for every row and silently swallow the
   * error rather than throw.
   */
  const resolveVars = resolveMutation.variables;
  const deferVars = deferMutation.variables;

  const acting: { askId: string; optionLetter?: string } | null =
    resolveMutation.isPending && resolveVars
      ? { askId: resolveVars.ask.id, optionLetter: resolveVars.optionLetter }
      : deferMutation.isPending && deferVars
        ? { askId: deferVars }
        : null;

  /** Which ask the last failure belongs to, so only that row shows it. */
  const failure =
    resolveMutation.error && resolveVars
      ? { askId: resolveVars.ask.id, error: resolveMutation.error }
      : deferMutation.error && deferVars
        ? { askId: deferVars, error: deferMutation.error }
        : null;

  return { resolveMutation, deferMutation, acting, failure, pendingId: acting?.askId ?? null };
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
  // Which control in THIS row is mid-request. `pending` says the row is busy;
  // this says which button the operator actually clicked (mt#4503) — on a row
  // offering three options, the first is not an answer to the second.
  const acting = actions.acting?.askId === ask.id ? actions.acting : null;
  const failure = actions.failure?.askId === ask.id ? actions.failure : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {inline.map((a) =>
          a.action === "resolve" ? (
            <PendingButton
              key={a.label}
              size="sm"
              variant={a.optionLetter === "A" ? "default" : "outline"}
              className={cn("h-6 min-w-0 px-2 text-xs", ACTION_LABEL_MAX_W)}
              pending={acting?.optionLetter === (a.optionLetter ?? "A")}
              disabled={pending}
              title={optionTitle(ask, a)}
              onClick={() =>
                actions.resolveMutation.mutate({ ask, optionLetter: a.optionLetter ?? "A" })
              }
            >
              <span className="truncate">{stripOptionLetterPrefix(a.label)}</span>
            </PendingButton>
          ) : (
            <PendingButton
              key={a.label}
              size="sm"
              variant="ghost"
              className="h-6 flex-shrink-0 px-2 text-xs"
              pending={acting !== null && acting.optionLetter === undefined}
              disabled={pending}
              onClick={() => actions.deferMutation.mutate(ask.id)}
            >
              {a.label}
            </PendingButton>
          )
        )}
      </div>
      {acting !== null && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="inline-ask-status">
          {acting.optionLetter === undefined ? "Deferring…" : "Saving your response…"}
        </p>
      )}
      {acting === null && failure !== null && (
        <div data-testid="inline-ask-error">
          <ErrorState
            prefix="Your response was not saved"
            error={failure.error}
            className="text-xs"
          />
        </div>
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
// Expanded row body — the full question + option descriptions.
// ---------------------------------------------------------------------------

/**
 * The question renders through the shared `<Prose>` Markdown renderer, not as
 * `whitespace-pre-wrap` text (mt#3639). Ask questions are agent-authored
 * Markdown — GFM comparison tables, emphasis, entity refs — and this surface
 * showed all of it as literal syntax while `/ask/:id` rendered the same field
 * correctly through `<Prose>`. Option labels and descriptions get the same
 * entity-linkification the detail page gives them.
 *
 * `Prose` keeps the band's muted tone via `className`: the expansion is
 * secondary to the row header, and the fix is about Markdown structure, not
 * about restyling the row. This is an override, not a conflict — `Prose`
 * composes its own `text-foreground/90` with the incoming class through
 * `cn()` (clsx + tailwind-merge), which resolves the pair to the caller's:
 * `cn("break-words text-sm text-foreground/90", "text-muted-foreground")`
 * returns `"break-words text-sm text-muted-foreground"`, so the outcome does
 * not depend on stylesheet order.
 *
 * Split out of `AskRow` so `useEntityIndex()` mounts only with an EXPANDED
 * row. The hook's TanStack queries dedupe across mounts, but its `useMemo`
 * id-set build does not — a queue of collapsed rows would each pay for one.
 */
function AskExpandedBody({ ask }: { ask: AskItem }) {
  const entityIndex = useEntityIndex();
  return (
    <div className="border-t border-border/60 px-9 py-2 text-sm text-muted-foreground">
      <Prose entityIndex={entityIndex} className="text-muted-foreground">
        {ask.question}
      </Prose>
      {ask.options && ask.options.length > 0 && (
        <ul className="mt-2 space-y-1">
          {ask.options.map((opt, i) => (
            <li key={`${opt.label}-${i}`} className="text-xs">
              <span className="font-medium text-foreground">
                {/* This surface renders the letter, so a producer's own
                    "B — " / "[b] " prefix would double it (mt#3253). */}
                {String.fromCharCode(65 + i)}.{" "}
                <LinkifiedText text={stripOptionLetterPrefix(opt.label)} index={entityIndex} />
              </span>
              {opt.description && (
                <span className="ml-1">
                  — <LinkifiedText text={opt.description} index={entityIndex} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One ask row — badge, title, inline actions, expandable question.
// ---------------------------------------------------------------------------

function AskRow({
  ask,
  actions,
  inGroup,
  resolved = false,
}: {
  ask: AskItem;
  actions: InlineAskActions;
  inGroup: boolean;
  /**
   * Render as a RECORD rather than a decision (mt#4092). A terminal ask has
   * nothing to act on, so the inline action bar is gone; the deadline and the
   * standing marker are gone too — both are statements about attention still
   * owed, and this ask no longer owes any. What replaces them is what the
   * operator came for: which terminal state it landed in, when it concluded,
   * and who concluded it.
   */
  resolved?: boolean;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const ks = kindStyle(ask.kind);
  const deadlineStr = resolved ? null : formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";
  const standing = !resolved && isStanding(ask);
  const pending = actions.pendingId === ask.id;
  const inline = resolved ? [] : inlineActionsFor(ask);
  const concludedAt = ask.closedAt ?? ask.respondedAt ?? ask.createdAt;

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
        {/* Which terminal state, named (mt#4092). `closed` is the ordinary
            answered case and reads as noise on every row, so it stays implicit;
            `cancelled` and `expired` mean the ask went away WITHOUT the
            operator answering it, which is exactly what someone hunting for a
            lost decision needs to see. */}
        {resolved && ask.state !== "closed" && (
          <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {ask.state}
          </span>
        )}
        {resolved && ask.response?.responder && (
          <span
            className="hidden flex-shrink-0 max-w-[140px] truncate text-xs italic text-muted-foreground sm:block"
            title={`Concluded by ${ask.response.responder}`}
          >
            {ask.response.responder}
          </span>
        )}
        <span
          className="w-14 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground"
          title={resolved ? `Concluded ${concludedAt}` : `Opened ${ask.createdAt}`}
        >
          {formatRelative(resolved ? concludedAt : ask.createdAt)}
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
          {!resolved && (
            <InlineActionBar ask={ask} actions={actions} inline={inline} pending={pending} />
          )}
        </div>
      )}

      {/* Expanded: the full question + option descriptions — the decision is
          readable here, without opening the detail page. Actions follow the
          question so the expanded read order is question → options → act. */}
      {expanded && (
        <>
          <AskExpandedBody ask={ask} />
          {!resolved && (
            <div className="px-3 pb-2 pl-9">
              <InlineActionBar ask={ask} actions={actions} inline={inline} pending={pending} />
            </div>
          )}
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

  /**
   * Pending is the DEFAULT and is not persisted (mt#4092). The page's job is to
   * show what still needs the principal; landing on a history view because of
   * something you did last week would defeat it. The resolved view is a
   * drill-down you ask for, every time.
   */
  const [view, setView] = useState<AskView>("pending");
  const resolvedView = view === "resolved";

  const query = useQuery<AsksListResponse, Error>({
    // A SEPARATE cache key from ["asks"] — that one is shared with the home
    // TriageBand, which must keep seeing only pending asks.
    queryKey: resolvedView ? ["asks", "terminal"] : ["asks"],
    queryFn: () => (resolvedView ? fetchTerminalAsks() : fetchAsks()),
    staleTime: resolvedView ? 60_000 : 10_000,
    // A record does not change under you; polling it every 10s buys nothing.
    refetchInterval: resolvedView ? false : 10_000,
  });

  const asks = query.data?.asks ?? [];
  const truncated = query.data?.truncated === true;
  const matchedTotal = query.data?.total ?? asks.length;

  const uniqueKinds = [...new Set(asks.map((a) => a.kind))].sort();
  const uniqueRequestors = [...new Set(asks.map((a) => a.requestor))].sort();
  const uniqueCohorts = [...new Set(asks.map((a) => a.windowKey ?? "(none)"))].sort();
  // Standing is "open past 24h" — a statement about attention still owed, so it
  // is meaningless once every row in the list is terminal (mt#4092). Left
  // uncomputed rather than merely unrendered: every resolved ask older than a
  // day satisfies isStanding(), so a resolved view would otherwise carry a
  // permanently over-budget alarm chip about nothing.
  const standingTotal = resolvedView ? 0 : asks.filter((a) => isStanding(a)).length;
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
          {filteredAsks.length > 0 && resolvedView && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {filteredAsks.length} resolved
              {/* Honest about the cap: the list is bounded, and saying so beats
                  a page that silently looks like the whole record. */}
              {truncated && ` of ${matchedTotal}`}
            </span>
          )}
          {filteredAsks.length > 0 && !resolvedView && (
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
          <Select value={view} onValueChange={(v) => setView(v as AskView)}>
            <SelectTrigger aria-label="View">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>

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

          {/* Sorts GROUPS, and the resolved view has none — its order is fixed
              at most-recently-concluded, which is the only order the "where did
              my ask go" question has an answer in. */}
          {!resolvedView && (
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
          )}

          {controls.hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={controls.clearFilters} className="text-xs">
              Clear
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState message="Loading..." variant="page" />
      ) : resolvedView ? (
        filteredAsks.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm font-medium text-foreground">No resolved asks</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {controls.hasActiveFilters
                ? "No asks match your current filters."
                : "Nothing has been closed, cancelled, or expired yet."}
            </p>
          </div>
        ) : (
          /* Flat and newest-concluded-first — NOT grouped. Unit-of-work bundles
             exist so N look-alike approvals become one decision; there is no
             decision left to make here, and grouping a record only hides rows
             behind a header. */
          <div className="space-y-1.5">
            {filteredAsks.map((ask) => (
              <AskRow key={ask.id} ask={ask} actions={actions} inGroup={false} resolved />
            ))}
          </div>
        )
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
