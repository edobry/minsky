/**
 * SessionFilmRibbon — the A0 event ribbon (mt#3184 — Watchable world Phase 1,
 * spec SC 4; glyphic-row redesign mt#3226 SC 1 / SC 2; legibility pass
 * mt#3231 SC 1 / SC 2 / SC 3).
 *
 * Batch-grain, virtualized rows: a parallel batch (`BatchRow.isParallelBatch`)
 * renders as ONE expandable "N parallel actions" row; a wall-clock density
 * annotation and a capture-gap annotation are distinct row decorations (not
 * separate rows — see the uniform-row-height note below); chapter headers
 * derive from Skill invocations (`session-film-batches.ts`'s `deriveChapters`).
 *
 * Glyphic row grammar (mt#3226 SC 2, replacing the v1 plain-prose row): a
 * VERB icon (`tool-icon.ts`'s `verbIconFor` — the SAME shared per-family icon
 * registry the conversation view's tool-invocation block uses, not a bespoke
 * duplicate set), a REALM color swatch (`session-film-config.ts`'s brand-token
 * accents, one of the existing VSM-organ colors per realm — never a raw hex),
 * and the target rendered via the mt#3174 EntityRef layer when it resolves to
 * a routable minsky-substrate entity (`session-film-target-ref.ts`), else a
 * plain display-label fallback (a file path, a domain, a shell digest — every
 * other realm has no routable id-space counterpart in v0). An actor marker
 * renders ONLY on actor-CHANGE (principal interjection, policy denial, spawn
 * boundary) — never repeated per-row in a single-actor film, per
 * `session-film-batches.ts`'s `deriveActorChanges`.
 *
 * ## Self-reference elision (mt#3231 SC 1 / AT 1)
 *
 * v1.1 diagnosis: the ACTOR column was already correctly suppressed except
 * on change; the repeated-`agent-<hex>` complaint was the TARGET column —
 * most events in a subagent film target that SAME subject agent (every
 * `speak`/`think` self-targets, the transcript's `ask` targets the subject
 * from the principal's side). `session-film-target-ref.ts`'s
 * `deriveFilmSubjectAgentId` finds that constant id once per events array;
 * `isSelfReferenceTarget` elides any row whose target IS it to a compact
 * `SELF_REFERENCE_LABEL` chip — never the raw repeated id. A genuine spawned
 * child's target (`agents:<kind>`, a DIFFERENT id) still renders its
 * meaningful short label via the ordinary fallback path.
 *
 * ## Icon + text-label badges (mt#3231 SC 2 / AT 2)
 *
 * A bare verb glyph under-communicated ("not clear it's doing stuff" was
 * partly a labeling problem, not just a motion one). Every row's icon now
 * pairs with a short word (`tool-icon.ts`'s `verbLabelFor` — the SAME shared
 * registry `verbIconFor` lives in, so a future legend draws from one
 * source) inside one compact badge.
 *
 * ## Click-to-expand inline accordion (mt#3231 SC 3 / AT 3)
 *
 * Supersedes the v1.1 module doc's "per-event detail lives in a SEPARATE
 * detail panel" rationale — the v1.2 finding explicitly wants INLINE, in-
 * place expansion instead. Clicking (or Enter/Space on) a row STILL fires
 * `onSelectRow` (the external highlight/detail-panel hook stays wired for
 * any future consumer) AND toggles a LOCAL `expandedRowIndex`: the row
 * renders its full per-event detail (target, verb, outcome, timing) directly
 * beneath itself; a batch row's expansion lists every member event. Rows use
 * `minHeight` (not the collapsed-only fixed `height`) so an expanded row
 * grows in normal document flow, pushing later rows down — the ONE row
 * whose true height diverges from `ROW_HEIGHT_PX` at a time introduces a
 * small, bounded drift in `session-film-virtualization.ts`'s uniform-height
 * window math for rows scrolled far below it; a full variable-height
 * virtualizer is out of this round's scope (nearest feasible treatment).
 *
 * Row root is a `<div role="listitem">` (not a `<button>`): EntityRef renders
 * an anchor internally, and nesting an anchor inside a native `<button>` is
 * invalid HTML (button forbids interactive-content descendants). The row
 * stays keyboard-operable via `tabIndex={0}` + an Enter/Space key handler.
 *
 * @see session-film-batches.ts — BatchRow / ChapterMarker / gap+wait/actor-change helpers
 * @see session-film-virtualization.ts — the windowing math this component wires up
 * @see session-film-target-ref.ts — EntityRef routing, display-label fallback, self-reference derivation
 * @see tool-icon.ts — the shared verb/actor icon + label registry
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { BatchRow, ChapterMarker } from "../../lib/session-film-batches";
import { deriveActorChanges, isWaitRow, precedingGapMs } from "../../lib/session-film-batches";
import { computeVisibleRowRange, rowIndexForScrollTop } from "../../lib/session-film-virtualization";
import { formatDurationShort } from "../../lib/format-duration";
import { cn } from "../../lib/utils";
import { actorIconFor, BATCH_ROW_ICON, BATCH_ROW_LABEL, verbIconFor, verbLabelFor } from "../../lib/tool-icon";
import { realmColorStyle } from "../../lib/session-film-config";
import {
  deriveFilmSubjectAgentId,
  isSelfReferenceTarget,
  parseRoutableTarget,
  SELF_REFERENCE_LABEL,
  targetDisplayLabel,
} from "../../lib/session-film-target-ref";
import { EntityRef } from "../EntityRef";

/** Fixed collapsed-row height, px — see the module doc's uniform-height rationale. */
export const ROW_HEIGHT_PX = 32;

/** Gaps at/above this duration render as a distinct capture-gap annotation (spec SC 4 / AT 4). */
export const CAPTURE_GAP_THRESHOLD_MS = 30_000;

export interface SessionFilmRibbonProps {
  events: readonly SemanticEvent[];
  batchRows: readonly BatchRow[];
  chapters: readonly ChapterMarker[];
  /** The current fold playhead — highlighted row. */
  playheadRowIndex: number;
  /** The row whose detail panel is open, if any (see the module doc's detail-panel rationale). */
  selectedRowIndex: number | null;
  onSelectRow: (rowIndex: number) => void;
  /** Fired as the user scrolls — the scroll-as-scrub coupling's row-change signal. */
  onScrollRowChange: (rowIndex: number) => void;
  className?: string;
}

function outcomeSuffix(outcome: SemanticEvent["outcome"]): string {
  if (outcome === undefined) return " [in-flight]";
  if (outcome !== "ok") return ` [${outcome}]`;
  return "";
}

/** A row's single dominant event, for the glyphic (non-batch) rendering path. */
function soleEvent(events: readonly SemanticEvent[], row: BatchRow): SemanticEvent | undefined {
  const idx = row.eventIndices[0];
  return idx !== undefined ? events[idx] : undefined;
}

/** Plain-text fallback summary (used when a row's event is missing — defensive only). */
function rowSummary(events: readonly SemanticEvent[], row: BatchRow): string {
  if (row.isParallelBatch) {
    return `${row.eventIndices.length} parallel actions`;
  }
  const event = soleEvent(events, row);
  if (!event) return "(unknown event)";
  return `${event.verb} ${event.target.id}${outcomeSuffix(event.outcome)}`;
}

/** Render one event's target — self-reference elision first, then routable EntityRef, then plain fallback (mt#3231 SC 1). */
function EventTargetLabel({
  event,
  subjectAgentId,
}: {
  event: SemanticEvent;
  subjectAgentId: string | null;
}) {
  if (isSelfReferenceTarget(event.target, subjectAgentId)) {
    return (
      <span data-testid="session-film-self-ref" className="italic text-muted-foreground/80">
        {SELF_REFERENCE_LABEL}
      </span>
    );
  }
  const routableTarget = parseRoutableTarget(event.target);
  if (routableTarget) {
    return <EntityRef type={routableTarget.type} id={routableTarget.id} className="truncate text-xs" />;
  }
  return <span className="truncate">{targetDisplayLabel(event.target)}</span>;
}

/** One member event's row inside an expanded batch's detail (mt#3231 SC 3 / AT 3). */
function EventDetailRow({
  event,
  index,
  subjectAgentId,
}: {
  event: SemanticEvent;
  index: number;
  subjectAgentId: string | null;
}) {
  const ActorIcon = actorIconFor(event.actor.kind);
  return (
    <div
      key={index}
      data-testid={`session-film-row-detail-event-${index}`}
      className="flex items-center gap-1.5 py-0.5 pl-6 text-[11px] text-muted-foreground"
    >
      <ActorIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-semibold text-foreground">{verbLabelFor(event.verb)}</span>
      <span className="min-w-0 flex-1 truncate">
        <EventTargetLabel event={event} subjectAgentId={subjectAgentId} />
      </span>
      <span className="shrink-0">{event.outcome ?? "in-flight"}</span>
    </div>
  );
}

/** Inline accordion detail for one row — a single event's full detail, or a batch's member-event list (mt#3231 SC 3 / AT 3). */
function RowDetail({
  events,
  row,
  subjectAgentId,
}: {
  events: readonly SemanticEvent[];
  row: BatchRow;
  subjectAgentId: string | null;
}) {
  if (row.isParallelBatch) {
    return (
      <div
        data-testid={`session-film-row-detail-${row.rowIndex}`}
        className="border-l-2 border-l-transparent bg-secondary/40 py-1"
      >
        {row.eventIndices.map((idx) => {
          const event = events[idx];
          return event ? (
            <EventDetailRow key={idx} event={event} index={idx} subjectAgentId={subjectAgentId} />
          ) : null;
        })}
      </div>
    );
  }
  const event = soleEvent(events, row);
  if (!event) return null;
  const duration =
    event.tEnd !== undefined
      ? formatDurationShort(Date.parse(event.tEnd) - Date.parse(event.tStart))
      : "in-flight";
  return (
    <div
      data-testid={`session-film-row-detail-${row.rowIndex}`}
      className="flex flex-col gap-0.5 border-l-2 border-l-transparent bg-secondary/40 py-1 pl-6 text-[11px] text-muted-foreground"
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-semibold text-foreground">Target:</span>
        <span className="min-w-0 flex-1 truncate">
          <EventTargetLabel event={event} subjectAgentId={subjectAgentId} />
        </span>
      </div>
      <div>
        <span className="font-semibold text-foreground">Verb:</span> {verbLabelFor(event.verb)}
      </div>
      <div>
        <span className="font-semibold text-foreground">Outcome:</span> {event.outcome ?? "in-flight"}
      </div>
      <div>
        <span className="font-semibold text-foreground">Duration:</span> {duration}
      </div>
    </div>
  );
}

export function SessionFilmRibbon({
  events,
  batchRows,
  chapters,
  playheadRowIndex,
  selectedRowIndex,
  onSelectRow,
  onScrollRowChange,
  className,
}: SessionFilmRibbonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeightPx, setViewportHeightPx] = useState(400);

  // Click-to-expand inline accordion (mt#3231 SC 3 / AT 3): LOCAL to the
  // ribbon — collapsing/expanding a row's detail doesn't need to round-trip
  // through the parent page. At most one row expanded at a time.
  const [expandedRowIndex, setExpandedRowIndex] = useState<number | null>(null);

  // Self-reference elision (mt#3231 SC 1 / AT 1): derived once per events
  // array — see the module doc + session-film-target-ref.ts.
  const subjectAgentId = useMemo(() => deriveFilmSubjectAgentId(events), [events]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewportHeightPx(el.clientHeight || 400);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(
    () => computeVisibleRowRange(scrollTop, viewportHeightPx, ROW_HEIGHT_PX, batchRows.length),
    [scrollTop, viewportHeightPx, batchRows.length]
  );

  const chapterByRow = useMemo(() => {
    const m = new Map<number, ChapterMarker>();
    for (const c of chapters) m.set(c.rowIndex, c);
    return m;
  }, [chapters]);

  // Actor-change annotation (mt#3226 SC 2 / AT 2): precomputed over the FULL
  // batchRows array (not just the virtualized window) — "did the actor
  // change from the PRECEDING row" is only answerable with full context, and
  // must stay stable regardless of which window happens to be mounted.
  const actorChangeRows = useMemo(
    () => deriveActorChanges(events, batchRows),
    [events, batchRows]
  );

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    onScrollRowChange(
      rowIndexForScrollTop(el.scrollTop, ROW_HEIGHT_PX, el.clientHeight || 400, batchRows.length)
    );
  }, [batchRows.length, onScrollRowChange]);

  const visibleRows: BatchRow[] = [];
  for (let i = range.start; i <= range.end; i++) {
    const row = batchRows[i];
    if (row) visibleRows.push(row);
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      data-testid="session-film-ribbon"
      role="list"
      aria-label="Session event ribbon"
      className={cn("relative flex-1 min-h-0 overflow-y-auto font-mono text-xs", className)}
    >
      <div style={{ height: range.totalHeightPx, position: "relative" }}>
        <div style={{ position: "absolute", top: range.offsetTopPx, left: 0, right: 0 }}>
          {visibleRows.map((row) => {
            const chapter = chapterByRow.get(row.rowIndex);
            const gapMs = precedingGapMs(batchRows, row.rowIndex);
            const wait = isWaitRow(row, events);
            const isCaptureGap = !wait && gapMs >= CAPTURE_GAP_THRESHOLD_MS;
            const isPlayhead = row.rowIndex === playheadRowIndex;
            const isSelected = row.rowIndex === selectedRowIndex;
            const isExpanded = row.rowIndex === expandedRowIndex;
            const firstEvent = soleEvent(events, row);
            const event = row.isParallelBatch ? undefined : firstEvent;
            const showActorMarker = actorChangeRows.has(row.rowIndex) && firstEvent !== undefined;
            const ActorIcon = firstEvent ? actorIconFor(firstEvent.actor.kind) : undefined;
            const RowIcon = row.isParallelBatch ? BATCH_ROW_ICON : event ? verbIconFor(event.verb) : undefined;
            const verbLabel = row.isParallelBatch
              ? BATCH_ROW_LABEL
              : event
                ? verbLabelFor(event.verb)
                : undefined;

            const activate = () => {
              onSelectRow(row.rowIndex);
              setExpandedRowIndex((cur) => (cur === row.rowIndex ? null : row.rowIndex));
            };

            return (
              <div key={row.rowIndex}>
                <div
                  data-testid={`session-film-row-${row.rowIndex}`}
                  data-row-index={row.rowIndex}
                  data-wait={wait ? "true" : undefined}
                  data-capture-gap={isCaptureGap ? "true" : undefined}
                  data-chapter={chapter ? "true" : undefined}
                  data-actor-change={showActorMarker ? "true" : undefined}
                  role="listitem"
                  tabIndex={0}
                  aria-current={isPlayhead ? "true" : undefined}
                  aria-expanded={isExpanded}
                  onClick={activate}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate();
                    }
                  }}
                  style={{ minHeight: ROW_HEIGHT_PX }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1.5 border-l-2 px-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    isPlayhead ? "border-l-primary bg-primary/10" : "border-l-transparent",
                    isSelected && "bg-secondary",
                    wait && "italic text-muted-foreground",
                    isCaptureGap && "text-muted-foreground/50"
                  )}
                >
                  {chapter ? (
                    <span
                      data-testid="session-film-chapter-label"
                      className="shrink-0 rounded bg-accent px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-accent-foreground"
                    >
                      {chapter.label}
                    </span>
                  ) : null}
                  {isCaptureGap ? (
                    <span
                      data-testid="session-film-capture-gap"
                      className="shrink-0 text-[10px] tracking-wide"
                    >
                      ⋯ gap {formatDurationShort(gapMs)} ⋯
                    </span>
                  ) : null}
                  {wait ? (
                    <span data-testid="session-film-wait-marker" className="shrink-0 text-[10px]">
                      ⏳ wait
                    </span>
                  ) : null}
                  {showActorMarker && ActorIcon ? (
                    <span
                      data-testid="session-film-actor-marker"
                      aria-label={`actor: ${firstEvent?.actor.kind}`}
                      className="shrink-0"
                      style={{ color: "oklch(var(--foreground))" }}
                    >
                      <ActorIcon className="size-3" aria-hidden="true" />
                    </span>
                  ) : null}
                  {RowIcon ? (
                    <span
                      data-testid="session-film-row-icon-badge"
                      className="flex shrink-0 items-center gap-0.5 rounded-sm bg-muted/60 px-1 py-px"
                    >
                      <RowIcon
                        data-testid="session-film-row-icon"
                        className="size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {verbLabel ? (
                        <span
                          data-testid="session-film-verb-label"
                          className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                        >
                          {verbLabel}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {event ? (
                    <span
                      data-testid="session-film-realm-swatch"
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: realmColorStyle(event.target.realm) }}
                    />
                  ) : null}
                  {event ? (
                    <span className="min-w-0 flex-1 truncate">
                      <EventTargetLabel event={event} subjectAgentId={subjectAgentId} />
                      <span className="text-muted-foreground">{outcomeSuffix(event.outcome)}</span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{rowSummary(events, row)}</span>
                  )}
                </div>
                {isExpanded ? <RowDetail events={events} row={row} subjectAgentId={subjectAgentId} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
