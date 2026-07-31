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
 * Per-row height is UNIFORM (collapsed-row height) by default, which is
 * what makes this O(1) windowing math correct in the common case. mt#3231's
 * click-to-expand inline accordion (`SessionFilmRibbon.tsx`) introduced
 * exactly ONE exception: at most one row can be taller than `rowHeightPx`
 * at a time. Rather than a general measured-height virtualizer
 * (react-window/react-virtual — still out of scope), every function below
 * accepts an OPTIONAL {@link ExpandedRowExtra} describing that single
 * row's real extra height; omitting it (or passing `null`) reproduces the
 * original uniform-only math exactly (see the "no expandedRow" tests in
 * this module's test file). See `rowLocalTop`/`rowIndexAtRowLocalY` below
 * for the shared position<->index inversion this bounded case needs.
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
 * One row whose ACTUAL rendered height exceeds the uniform `rowHeightPx` —
 * the inline accordion expansion (mt#3231 SC 3 / AT 3, review R1 non-
 * blocking #4). Bounded to a SINGLE row because the ribbon only ever
 * expands one row at a time (`SessionFilmRibbon`'s `expandedRowIndex`
 * state) — this is deliberately NOT a general variable-height virtualizer;
 * it's the narrow "at most one row is taller" case, kept exact rather than
 * approximated.
 */
export interface ExpandedRowExtra {
  /** Index of the row whose rendered height is taller than `rowHeightPx`. */
  rowIndex: number;
  /** How much taller, in px (its real rendered height minus `rowHeightPx`). `<= 0` is treated as "no expansion" (see the null-coalescing helper below). */
  extraHeightPx: number;
}

/** Normalizes an `ExpandedRowExtra` — `null`/non-positive `extraHeightPx` both collapse to "uniform, no expanded row" so callers don't need to special-case the zero case everywhere. */
function normalizeExpanded(expanded: ExpandedRowExtra | null | undefined): ExpandedRowExtra | null {
  return expanded && expanded.extraHeightPx > 0 ? expanded : null;
}

/**
 * Row-local Y position where row `index` STARTS, accounting for the ONE
 * expanded row's extra height if `index` is past it. Rows at or before
 * `expanded.rowIndex` are unaffected (uniform, as if nothing were
 * expanded); every row strictly after it is pushed down by
 * `expanded.extraHeightPx` — exactly the visual document-flow consequence
 * of the expanded row's real (taller) rendered height.
 */
function rowLocalTop(
  index: number,
  rowHeightPx: number,
  expanded: ExpandedRowExtra | null
): number {
  const base = index * rowHeightPx;
  return expanded && index > expanded.rowIndex ? base + expanded.extraHeightPx : base;
}

/**
 * Inverse of {@link rowLocalTop}: given a row-local Y position, the row
 * index whose SPAN contains it. Uniform division (`Math.floor(y /
 * rowHeightPx)`) is correct everywhere except across the expanded row's own
 * (taller) span and everything after it, where the extra height has to be
 * un-done before dividing.
 */
function rowIndexAtRowLocalY(
  y: number,
  rowHeightPx: number,
  expanded: ExpandedRowExtra | null
): number {
  if (!expanded) return Math.floor(y / rowHeightPx);
  const expandedTop = expanded.rowIndex * rowHeightPx;
  const expandedBottom = expandedTop + rowHeightPx + expanded.extraHeightPx;
  if (y < expandedTop) return Math.floor(y / rowHeightPx);
  if (y < expandedBottom) return expanded.rowIndex;
  return expanded.rowIndex + 1 + Math.floor((y - expandedBottom) / rowHeightPx);
}

/**
 * Compute the visible row window for uniform-height virtualization — with
 * an optional single variable-height (expanded) row (mt#3231 review R1,
 * non-blocking #4: "make the virtualizer aware of the expanded row's
 * variable height" so accordion expansion doesn't corrupt the scroll-as-
 * scrub playhead mapping for rows scrolled past it).
 *
 * @param scrollTop Current scrollTop of the ribbon's scroll container, px.
 * @param viewportHeightPx Visible height of the scroll container, px.
 * @param rowHeightPx Fixed height of one collapsed row, px.
 * @param rowCount Total number of rows.
 * @param overscan Extra rows to mount above/below the visible window (smooths fast scroll/keyboard stepping).
 * @param expandedRow The one row whose REAL rendered height exceeds `rowHeightPx`, if any (see {@link ExpandedRowExtra}).
 */
export function computeVisibleRowRange(
  scrollTop: number,
  viewportHeightPx: number,
  rowHeightPx: number,
  rowCount: number,
  overscan = 6,
  expandedRow: ExpandedRowExtra | null = null
): VisibleRowRange {
  if (rowCount <= 0 || rowHeightPx <= 0) {
    return { start: 0, end: -1, totalHeightPx: 0, offsetTopPx: 0 };
  }
  const expanded = normalizeExpanded(expandedRow);

  // Leading half-viewport spacer (see module doc's scroll-padding fix): row 0's
  // rendered content-y is `halfViewport`, not 0. Convert the viewport's
  // content-y window into ROW-LOCAL space (subtracting the spacer) before
  // deriving which row indices overlap it.
  const halfViewport = viewportHeightPx / 2;
  const rowLocalScrollTop = scrollTop - halfViewport;
  const firstVisible = rowIndexAtRowLocalY(rowLocalScrollTop, rowHeightPx, expanded);
  const lastVisible = rowIndexAtRowLocalY(
    rowLocalScrollTop + viewportHeightPx,
    rowHeightPx,
    expanded
  );

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount - 1, lastVisible + overscan);

  const extraTotal = expanded ? expanded.extraHeightPx : 0;

  return {
    start,
    end,
    // +viewportHeightPx: one full extra viewport of scrollable space, split
    // as a half-viewport spacer above row 0 and below the final row.
    // +extraTotal: the expanded row's own extra height also extends the
    // total scrollable area — otherwise the final rows would become
    // unreachable by exactly the amount the expanded row grew.
    totalHeightPx: rowCount * rowHeightPx + viewportHeightPx + extraTotal,
    // Add the leading spacer back — `start` is in row-local space, but the
    // mounted window renders in CONTENT space (where the spacer lives).
    offsetTopPx: halfViewport + rowLocalTop(start, rowHeightPx, expanded),
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
 *
 * @param expandedRow Same single variable-height row {@link computeVisibleRowRange} accepts — keeps this inverse consistent when a row is expanded.
 */
export function scrollTopForRow(
  rowIndex: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  totalHeightPx: number,
  expandedRow: ExpandedRowExtra | null = null
): number {
  const expanded = normalizeExpanded(expandedRow);
  const top = rowLocalTop(rowIndex, rowHeightPx, expanded);
  const ownHeight =
    expanded && expanded.rowIndex === rowIndex ? rowHeightPx + expanded.extraHeightPx : rowHeightPx;
  const rawTop = top + ownHeight / 2;
  return Math.max(0, Math.min(rawTop, Math.max(0, totalHeightPx - viewportHeightPx)));
}

/**
 * Given a scrollTop, the row index whose SPAN contains the viewport's
 * vertical center — the row that "owns" the playhead. As with
 * {@link scrollTopForRow}, the leading half-viewport spacer cancels the
 * `+ viewportHeightPx / 2` viewport-center term exactly, leaving a simple
 * row-local-Y lookup — this is what makes row 0 reachable at
 * `scrollTop = 0` and the final row reachable at max `scrollTop` (mt#3226
 * SC 3 / AT 1 — previously neither was attainable; see module doc).
 * `viewportHeightPx` is kept as a parameter for call-site symmetry with
 * {@link scrollTopForRow} even though it cancels out of the formula itself.
 *
 * @param expandedRow Same single variable-height row {@link computeVisibleRowRange} accepts (mt#3231 review R1, non-blocking #4) — without this, the playhead mapping drifts by the expanded row's extra height for every row scrolled past it.
 */
export function rowIndexForScrollTop(
  scrollTop: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  rowCount: number,
  expandedRow: ExpandedRowExtra | null = null
): number {
  if (rowCount <= 0 || rowHeightPx <= 0 || viewportHeightPx <= 0) return 0;
  const expanded = normalizeExpanded(expandedRow);
  const idx = rowIndexAtRowLocalY(scrollTop, rowHeightPx, expanded);
  return Math.max(0, Math.min(rowCount - 1, idx));
}
