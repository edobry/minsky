/**
 * Tests for session-film-virtualization.ts (mt#3184).
 */
import { describe, test, expect } from "bun:test";
import {
  computeVisibleRowRange,
  rowIndexForScrollTop,
  scrollTopForRow,
} from "./session-film-virtualization";

describe("computeVisibleRowRange", () => {
  test("at scrollTop=0, mounts from row 0 through viewport+overscan", () => {
    const range = computeVisibleRowRange(0, 400, 20, 1000, 6);
    expect(range.start).toBe(0);
    // lastVisible = ceil(400/20) = 20; +overscan 6 = 26
    expect(range.end).toBe(26);
    expect(range.totalHeightPx).toBe(20_000);
    expect(range.offsetTopPx).toBe(0);
  });

  test("scrolled deep into a long list mounts only a bounded window, not every row", () => {
    const rowCount = 5000;
    const range = computeVisibleRowRange(50_000, 400, 20, rowCount, 6);
    const mounted = range.end - range.start + 1;
    // Viewport fits 20 rows + 2*overscan; must stay small regardless of rowCount.
    expect(mounted).toBeLessThan(60);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(rowCount - 1);
  });

  test("clamps to [0, rowCount-1] at the very end of the list", () => {
    const range = computeVisibleRowRange(19_900, 400, 20, 1000, 6);
    expect(range.end).toBe(999);
  });

  test("degenerates to an empty range for zero rows", () => {
    const range = computeVisibleRowRange(0, 400, 20, 0);
    expect(range.end).toBeLessThan(range.start);
    expect(range.totalHeightPx).toBe(0);
  });
});

describe("scrollTopForRow / rowIndexForScrollTop — round trip", () => {
  test("scrolling to a row and reading it back yields the same row (within rounding)", () => {
    const rowHeight = 24;
    const viewport = 500;
    const rowCount = 200;
    const total = rowCount * rowHeight;
    for (const target of [0, 10, 100, 199]) {
      const scrollTop = scrollTopForRow(target, rowHeight, viewport, total);
      const back = rowIndexForScrollTop(scrollTop, rowHeight, viewport, rowCount);
      // Clamped rows (near the very start/end) can't center exactly — allow small slack.
      expect(Math.abs(back - target)).toBeLessThanOrEqual(11);
    }
  });

  test("scrollTopForRow never scrolls past the bottom of the content", () => {
    const scrollTop = scrollTopForRow(9999, 24, 500, 24 * 200);
    expect(scrollTop).toBeLessThanOrEqual(24 * 200 - 500);
  });

  test("rowIndexForScrollTop clamps within [0, rowCount-1]", () => {
    expect(rowIndexForScrollTop(0, 24, 500, 50)).toBeGreaterThanOrEqual(0);
    expect(rowIndexForScrollTop(1_000_000, 24, 500, 50)).toBe(49);
  });
});
