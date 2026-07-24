/**
 * Ribbon virtualization math (mt#3184 — Watchable world Phase 1, spec SC 4:
 * "virtualized").
 *
 * Pure, DOM-free windowing calculation — uniform-height row virtualization
 * (the classic top-spacer/bottom-spacer pattern): given a scroll position
 * and viewport size, compute which row INDICES should actually mount. Kept
 * as a standalone pure function (not folded into the component) so the
 * windowing math is unit-testable without a real layout engine — jsdom has
 * no real box layout, so asserting "N rows mounted" against a live component
 * would depend on unreliable getBoundingClientRect mocking; this function
 * is exhaustively testable on its own.
 *
 * Per-row height is deliberately UNIFORM (collapsed-row height only): a
 * selected row's per-event detail renders in a separate detail panel
 * (SessionFilmRibbon's `onSelectRow`), not as inline-expanding content
 * within the virtualized row — that keeps every row's height constant,
 * which is what makes this O(1) windowing math correct. A future iteration
 * that wants truly variable-height inline expansion would need a
 * measured-height virtualizer (react-window/react-virtual); out of scope
 * for the Phase 1 MVP.
 */

export interface VisibleRowRange {
  /** First row index to mount (inclusive). */
  start: number;
  /** Last row index to mount (inclusive). */
  end: number;
  /** Total scrollable height in px — for the spacer/scrollbar-thumb sizing. */
  totalHeightPx: number;
  /** Height of the spacer BEFORE `start` — positions the mounted window correctly. */
  offsetTopPx: number;
}

/**
 * Compute the visible row window for uniform-height virtualization.
 *
 * @param scrollTop Current scrollTop of the ribbon's scroll container, px.
 * @param viewportHeightPx Visible height of the scroll container, px.
 * @param rowHeightPx Fixed height of one collapsed row, px.
 * @param rowCount Total number of rows.
 * @param overscan Extra rows to mount above/below the visible window (smooths fast scroll/keyboard stepping).
 */
export function computeVisibleRowRange(
  scrollTop: number,
  viewportHeightPx: number,
  rowHeightPx: number,
  rowCount: number,
  overscan = 6
): VisibleRowRange {
  if (rowCount <= 0 || rowHeightPx <= 0) {
    return { start: 0, end: -1, totalHeightPx: 0, offsetTopPx: 0 };
  }

  const firstVisible = Math.floor(scrollTop / rowHeightPx);
  const lastVisible = Math.ceil((scrollTop + viewportHeightPx) / rowHeightPx);

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount - 1, lastVisible + overscan);

  return {
    start,
    end,
    totalHeightPx: rowCount * rowHeightPx,
    offsetTopPx: start * rowHeightPx,
  };
}

/** The scrollTop (px) that would center `rowIndex` in a viewport of `viewportHeightPx`. */
export function scrollTopForRow(
  rowIndex: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  totalHeightPx: number
): number {
  const rawTop = rowIndex * rowHeightPx - viewportHeightPx / 2 + rowHeightPx / 2;
  return Math.max(0, Math.min(rawTop, Math.max(0, totalHeightPx - viewportHeightPx)));
}

/** Given a scrollTop, the row index whose center is closest to the viewport's vertical center — the row that "owns" the playhead. */
export function rowIndexForScrollTop(
  scrollTop: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  rowCount: number
): number {
  if (rowCount <= 0 || rowHeightPx <= 0) return 0;
  const centerY = scrollTop + viewportHeightPx / 2;
  const idx = Math.floor(centerY / rowHeightPx);
  return Math.max(0, Math.min(rowCount - 1, idx));
}
