/**
 * SessionFilmRibbon — the A0 event ribbon (mt#3184 — Watchable world Phase 1,
 * spec SC 4; glyphic-row redesign mt#3226 SC 1 / SC 2).
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
 * Row root is a `<div role="listitem">` (not a `<button>`): EntityRef renders
 * an anchor internally, and nesting an anchor inside a native `<button>` is
 * invalid HTML (button forbids interactive-content descendants). The row
 * stays keyboard-operable via `tabIndex={0}` + an Enter/Space key handler.
 *
 * Uniform-row-height simplification: every row renders at the SAME fixed
 * height (`ROW_HEIGHT_PX`) regardless of chapter/gap/wait status — the
 * chapter label, gap duration, and wait indicator are all INLINE
 * annotations within a row's content rather than extra virtualized rows.
 * This keeps `session-film-virtualization.ts`'s O(1) uniform-height window
 * math exactly correct (a variable-height virtualizer is out of MVP scope).
 * Per-event detail for a batch lives in a SEPARATE detail panel
 * (`onSelectRow` + the parent page's detail view), not inline-expanding
 * content — same rationale.
 *
 * @see session-film-batches.ts — BatchRow / ChapterMarker / gap+wait/actor-change helpers
 * @see session-film-virtualization.ts — the windowing math this component wires up
 * @see session-film-target-ref.ts — EntityRef routing / display-label fallback
 * @see tool-icon.ts — the shared verb/actor icon registry
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { BatchRow, ChapterMarker } from "../../lib/session-film-batches";
import { deriveActorChanges, isWaitRow, precedingGapMs } from "../../lib/session-film-batches";
import { computeVisibleRowRange, rowIndexForScrollTop } from "../../lib/session-film-virtualization";
import { formatDurationShort } from "../../lib/format-duration";
import { cn } from "../../lib/utils";
import { actorIconFor, BATCH_ROW_ICON, verbIconFor } from "../../lib/tool-icon";
import { realmColorStyle } from "../../lib/session-film-config";
import { parseRoutableTarget, targetDisplayLabel } from "../../lib/session-film-target-ref";
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
            const firstEvent = soleEvent(events, row);
            const event = row.isParallelBatch ? undefined : firstEvent;
            const routableTarget = event ? parseRoutableTarget(event.target) : null;
            const showActorMarker = actorChangeRows.has(row.rowIndex) && firstEvent !== undefined;
            const ActorIcon = firstEvent ? actorIconFor(firstEvent.actor.kind) : undefined;
            const RowIcon = row.isParallelBatch ? BATCH_ROW_ICON : event ? verbIconFor(event.verb) : undefined;

            const activate = () => onSelectRow(row.rowIndex);

            return (
              <div
                key={row.rowIndex}
                data-testid={`session-film-row-${row.rowIndex}`}
                data-row-index={row.rowIndex}
                data-wait={wait ? "true" : undefined}
                data-capture-gap={isCaptureGap ? "true" : undefined}
                data-chapter={chapter ? "true" : undefined}
                data-actor-change={showActorMarker ? "true" : undefined}
                role="listitem"
                tabIndex={0}
                aria-current={isPlayhead ? "true" : undefined}
                onClick={activate}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }}
                style={{ height: ROW_HEIGHT_PX }}
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
                  <RowIcon
                    data-testid="session-film-row-icon"
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
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
                    {routableTarget ? (
                      <EntityRef
                        type={routableTarget.type}
                        id={routableTarget.id}
                        className="truncate text-xs"
                      />
                    ) : (
                      <span className="truncate">{targetDisplayLabel(event.target)}</span>
                    )}
                    <span className="text-muted-foreground">{outcomeSuffix(event.outcome)}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{rowSummary(events, row)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
