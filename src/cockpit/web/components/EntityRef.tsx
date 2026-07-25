/**
 * EntityRef — shared inline entity-reference component (mt#3174).
 *
 * The Shape-3 counterpart to <Prose>'s linkifier anchors: renders a
 * structured `{type, id}` field (e.g. `ask.parentTaskId`,
 * `record.sourceSessionId`, `event.relatedTaskId`) as an in-SPA link with
 * the same badge + hover-card treatment as a prose anchor — inline and
 * density-preserving (NOT a `link-card`; see mt#3165 §"Why a new component
 * rather than reusing link-card.tsx").
 *
 * Two rendering modes:
 *   - `children` provided (the <Prose> `a` override's usage, below): the
 *     exact given content is the link's visible text — EntityRef adds ONLY
 *     the hover affordance around it. This preserves whatever raw substring
 *     the linkifier matched (a full id, or a resolved prefix) with zero risk
 *     of mismatch, and is what keeps the failure-tolerance guarantee: with
 *     the label channel down, the rendered output is byte-identical to a
 *     plain anchor — no badge shell, no spinner, no layout shift.
 *
 *     With `appendLabel` set, a resolved label is additionally appended after
 *     the matched text, TRUNCATED (mt#3189). The matched substring is still
 *     rendered verbatim — a prose citation of a resolved prefix (`bd38be2c`)
 *     is never rewritten to the full id. Callers that must not grow their
 *     line height (dense list rows: ActivityPage, MemoriesList, TaskGraph)
 *     simply omit the flag and are unaffected.
 *   - `children` omitted (the Shape-3 structured-field usage): EntityRef
 *     derives its own inline text — the bare `id` until/unless a label
 *     resolves, then `id · label` (tasks additionally show a small status
 *     chip inline, per the mt#3174 acceptance test: "task shows title +
 *     status"). An id with no resolvable label — unresolved lookup, or the
 *     entity has no label source at all — degrades to a plain linked id,
 *     never a dead span or an empty shell.
 *
 * Hover is ADDITIVE ONLY (mt#3165 "Hover is supplementary" — Radix
 * HoverCard is documented as inaccessible to keyboard navigation and ignored
 * by screen readers): the inline text above never depends on the hover card
 * having been triggered. Nothing load-bearing lives only in
 * `HoverCardContent`. `appendLabel` exists precisely to honor that rule in
 * prose, where children mode previously left the title hover-only (mt#3189).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { entityToPath, type RoutableEntityType } from "../lib/entity-codec";
import { useResolvedEntityLabel, type EntityLabelInfo } from "../lib/use-entity-index";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "./ui/hover-card";
import { statusStyle } from "../lib/status-colors";

const LINK_CLASS = "font-mono text-primary underline-offset-2 hover:underline";

/**
 * Inline-label budget for `appendLabel` (mt#3189). Bounds a prose reference to
 * roughly one line at cockpit's prose width; the untruncated title remains in
 * the hover card. Deliberately a single constant — this is the tuning knob the
 * spec calls out, adjustable without touching render logic.
 */
const MAX_INLINE_LABEL_CHARS = 48;

/** Truncate `label` to the inline budget, with an ellipsis when shortened. */
export function truncateLabel(label: string, max: number = MAX_INLINE_LABEL_CHARS): string {
  const trimmed = label.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}

const TYPE_LABEL: Record<RoutableEntityType, string> = {
  task: "Task",
  ask: "Ask",
  session: "Session",
  memory: "Memory",
  changeset: "Changeset",
  conversation: "Conversation",
};

export interface EntityRefProps {
  type: RoutableEntityType;
  id: string;
  /**
   * Optional pre-rendered inline content (e.g. the literal matched prose
   * text). When omitted, EntityRef derives its own `id [+ label]` text.
   */
  children?: ReactNode;
  /**
   * Append the resolved label (truncated) after `children` (mt#3189). Only
   * meaningful alongside `children`; ignored in derived-text mode, which
   * already renders the label. Opt-in so dense rows keep their line height.
   */
  appendLabel?: boolean;
  className?: string;
}

function StatusChip({ status }: { status: string }) {
  const style = statusStyle(status);
  return (
    <span
      className="ml-1 rounded px-1 py-px align-middle text-[0.65em] font-sans font-medium uppercase tracking-wide"
      style={{ backgroundColor: style.background, color: style.color }}
    >
      {status}
    </span>
  );
}

function defaultInline(type: RoutableEntityType, id: string, info: EntityLabelInfo | null) {
  return (
    <>
      <span>{id}</span>
      {info?.label ? <span className="text-muted-foreground"> · {info.label}</span> : null}
      {type === "task" && info?.status ? <StatusChip status={info.status} /> : null}
    </>
  );
}

function EntityHoverContent({
  type,
  id,
  info,
}: {
  type: RoutableEntityType;
  id: string;
  info: EntityLabelInfo | null;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {TYPE_LABEL[type]}
      </div>
      <div className="font-mono text-xs text-foreground/80">{id}</div>
      {info?.label ? <div className="text-sm font-medium text-foreground">{info.label}</div> : null}
      {info?.status ? <div className="text-xs text-muted-foreground">{info.status}</div> : null}
      {!info ? (
        <div className="text-xs text-muted-foreground">No additional details available.</div>
      ) : null}
    </div>
  );
}

/**
 * Renders `{type, id}` as an in-SPA link. See the module doc above for the
 * two rendering modes (`children` provided vs. omitted).
 */
export function EntityRef({ type, id, children, appendLabel, className }: EntityRefProps) {
  const info = useResolvedEntityLabel(type, id);
  const to = entityToPath(type, id);

  // Children mode with appendLabel: matched text verbatim, then the truncated
  // label. With no resolved label the appended span is absent entirely, so the
  // output is byte-identical to plain children mode — the failure-tolerance
  // guarantee is preserved, not newly traded away (mt#3189).
  const inline =
    children != null ? (
      <>
        {children}
        {appendLabel && info?.label ? (
          <span className="font-sans font-normal text-muted-foreground">
            {" · "}
            {truncateLabel(info.label)}
          </span>
        ) : null}
      </>
    ) : (
      defaultInline(type, id, info)
    );

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to={to} className={cn(LINK_CLASS, className)}>
          {inline}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent>
        <EntityHoverContent type={type} id={id} info={info} />
      </HoverCardContent>
    </HoverCard>
  );
}