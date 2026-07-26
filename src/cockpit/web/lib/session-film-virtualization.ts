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
 *
 * ## Scroll-padding fix (mt#3226 SC 3 / AT 1)
 *
 * First operator viewing found event 0 and the final event UNREACHABLE as
 * centered playhead positions — "feels like a bug... it is." Root cause:
 * `rowIndexForScrollTop` picks the row at the VIEWPORT'S VERTICAL CENTER
 * (`scrollTop + viewportHeightPx / 2`), but row 0's own content-space
 * position starts at `scrollTop = 0` — so at `scrollTop = 0` the viewport's
 * center falls `viewportHeightPx / 2` past row 0, landing on whatever row
 * happens to sit there instead. Symmetric leading/trailing HALF-VIEWPORT
 * spacers fix this: row 0's rendered top moves to content-y
 * `viewportHeightPx / 2` (not 0), so when `scrollTop = 0` the viewport's
 * center exactly meets row 0. The trailing spacer gives the same guarantee
 * at the other end (the final row's center meets the viewport's center at
 * max `scrollTop`). Because the leading spacer is defined as EXACTLY
 * `viewportHeightPx / 2`, it cancels the `+ viewportHeightPx / 2` term
 * algebraically — `rowIndexForScrollTop` and `scrollTopForRow` end up not
 * needing to reference `viewportHeightPx` in their bodies at all (kept as a
 * parameter for signature/caller-symmetry and to bound the clamp range).
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

  // Leading half-viewport spacer (see module doc's scroll-padding fix): row 0's
  // rendered content-y is `halfViewport`, not 0. Convert the viewport's
  // content-y window into ROW-LOCAL space (subtracting the spacer) before
  // deriving which row indices overlap it.
  const halfViewport = viewportHeightPx / 2;
  const rowLocalScrollTop = scrollTop - halfViewport;
  const firstVisible = Math.floor(rowLocalScrollTop / rowHeightPx);
  const lastVisible = Math.ceil((rowLocalScrollTop + viewportHeightPx) / rowHeightPx);

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount - 1, lastVisible + overscan);

  return {
    start,
    end,
    // +viewportHeightPx: one full extra viewport of scrollable space, split
    // as a half-viewport spacer above row 0 and below the final row.
    totalHeightPx: rowCount * rowHeightPx + viewportHeightPx,
    // Add the leading spacer back — `start` is in row-local space, but the
    // mounted window renders in CONTENT space (where the spacer lives).
    offsetTopPx: halfViewport + start * rowHeightPx,
  };
}

/**
 * The scrollTop (px) that would center `rowIndex` in a viewport of
 * `viewportHeightPx`. `totalHeightPx` is expected to already include the
 * leading+trailing half-viewport spacers (i.e. the value
 * {@link computeVisibleRowRange} returns) — the leading spacer and the
 * `- viewportHeightPx / 2` viewport-centering term cancel exactly (both are
 * `viewportHeightPx / 2` by construction), so `rawTop` only needs the row's
 * own half-height offset.
 */
export function scrollTopForRow(
  rowIndex: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  totalHeightPx: number
): number {
  const rawTop = rowIndex * rowHeightPx + rowHeightPx / 2;
  return Math.max(0, Math.min(rawTop, Math.max(0, totalHeightPx - viewportHeightPx)));
}

/**
 * Given a scrollTop, the row index whose SPAN contains the viewport's
 * vertical center — the row that "owns" the playhead. As with
 * {@link scrollTopForRow}, the leading half-viewport spacer cancels the
 * `+ viewportHeightPx / 2` viewport-center term exactly, leaving a simple
 * `scrollTop / rowHeightPx` — this is what makes row 0 reachable at
 * `scrollTop = 0` and the final row reachable at max `scrollTop` (mt#3226
 * SC 3 / AT 1 — previously neither was attainable; see module doc).
 * `viewportHeightPx` is kept as a parameter for call-site symmetry with
 * {@link scrollTopForRow} even though it cancels out of the formula itself.
 */
export function rowIndexForScrollTop(
  scrollTop: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  rowCount: number
): number {
  if (rowCount <= 0 || rowHeightPx <= 0 || viewportHeightPx <= 0) return 0;
  const idx = Math.floor(scrollTop / rowHeightPx);
  return Math.max(0, Math.min(rowCount - 1, idx));
}
