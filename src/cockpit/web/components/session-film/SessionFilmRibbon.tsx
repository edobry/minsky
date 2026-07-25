/**
 * SessionFilmRibbon — the A0 event ribbon (mt#3184 — Watchable world Phase 1,
 * spec SC 4).
 *
 * Batch-grain, virtualized rows: a parallel batch (`BatchRow.isParallelBatch`)
 * renders as ONE expandable "N parallel actions" row; a wall-clock density
 * annotation and a capture-gap annotation are distinct row decorations (not
 * separate rows — see the uniform-row-height note below); chapter headers
 * derive from Skill invocations (`session-film-batches.ts`'s `deriveChapters`).
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
 * @see session-film-batches.ts — BatchRow / ChapterMarker / gap+wait helpers
 * @see session-film-virtualization.ts — the windowing math this component wires up
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { BatchRow, ChapterMarker } from "../../lib/session-film-batches";
import { isWaitRow, precedingGapMs } from "../../lib/session-film-batches";
import { computeVisibleRowRange, rowIndexForScrollTop } from "../../lib/session-film-virtualization";
import { formatDurationShort } from "../../lib/format-duration";
import { cn } from "../../lib/utils";

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

function rowSummary(events: readonly SemanticEvent[], row: BatchRow): string {
  if (row.isParallelBatch) {
    return `${row.eventIndices.length} parallel actions`;
  }
  const idx = row.eventIndices[0];
  const event = idx !== undefined ? events[idx] : undefined;
  if (!event) return "(unknown event)";
  const outcomeSuffix =
    event.outcome === undefined ? " [in-flight]" : event.outcome !== "ok" ? ` [${event.outcome}]` : "";
  return `${event.verb} ${event.target.id}${outcomeSuffix}`;
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

            return (
              <button
                key={row.rowIndex}
                type="button"
                data-testid={`session-film-row-${row.rowIndex}`}
                data-row-index={row.rowIndex}
                data-wait={wait ? "true" : undefined}
                data-capture-gap={isCaptureGap ? "true" : undefined}
                data-chapter={chapter ? "true" : undefined}
                role="listitem"
                aria-current={isPlayhead ? "true" : undefined}
                onClick={() => onSelectRow(row.rowIndex)}
                style={{ height: ROW_HEIGHT_PX }}
                className={cn(
                  "flex w-full items-center gap-2 border-l-2 px-2 text-left",
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
                <span className="truncate">{rowSummary(events, row)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
