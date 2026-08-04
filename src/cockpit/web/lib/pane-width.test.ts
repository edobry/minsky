/**
 * Pane-width arithmetic + persistence (mt#3701).
 *
 * These cover the decisions a unit test CAN settle. What a real box measures is
 * covered by `scripts/verify-session-film-panes.ts` over CDP, because happy-dom
 * reports 0 for every geometry read (src/cockpit/CLAUDE.md §Asserting layout
 * geometry) — the `containerWidth` cases below therefore pass a width in
 * directly rather than pretending to measure one.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/lib/pane-width.test.ts
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { clampPaneWidth, loadPaneWidth, paneWidthCeiling, savePaneWidth } from "./pane-width";

const BOUNDS = { min: 192, max: 640 };
const KEY = "test.pane-width";

beforeEach(() => {
  localStorage.clear();
});

describe("clampPaneWidth", () => {
  test("passes a width already inside the bounds through, rounded", () => {
    expect(clampPaneWidth(300, BOUNDS)).toBe(300);
    expect(clampPaneWidth(300.4, BOUNDS)).toBe(300);
    expect(clampPaneWidth(300.6, BOUNDS)).toBe(301);
  });

  test("clamps to min and max", () => {
    expect(clampPaneWidth(-2000, BOUNDS)).toBe(192);
    expect(clampPaneWidth(191, BOUNDS)).toBe(192);
    expect(clampPaneWidth(5000, BOUNDS)).toBe(640);
  });

  test("an unmeasured container leaves the fraction bound inert", () => {
    // First render, before the ResizeObserver has reported: a `containerWidth`
    // of 0 must not collapse every width to the minimum.
    expect(clampPaneWidth(400, { ...BOUNDS, containerWidth: 0, maxFraction: 0.6 })).toBe(400);
  });

  test("the container fraction caps the width below max", () => {
    // 0.6 of 800 is 480 — tighter than the 640 max, so it wins.
    expect(clampPaneWidth(640, { ...BOUNDS, containerWidth: 800, maxFraction: 0.6 })).toBe(480);
    // Comfortably inside the fraction: untouched.
    expect(clampPaneWidth(300, { ...BOUNDS, containerWidth: 800, maxFraction: 0.6 })).toBe(300);
  });

  test("min wins over the fraction when the container is too narrow for both", () => {
    // 0.6 of 200 is 120, below the 192 floor. A pane narrower than min is
    // illegible rather than merely cramped, so the floor takes precedence and
    // the window is simply too small for the split.
    expect(clampPaneWidth(300, { ...BOUNDS, containerWidth: 200, maxFraction: 0.6 })).toBe(192);
  });

  test("a non-finite width collapses to min instead of propagating", () => {
    // Every caller feeds this into a `width` style, where NaN renders as no
    // width constraint at all and silently un-does the split.
    expect(clampPaneWidth(Number.NaN, BOUNDS)).toBe(192);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY, BOUNDS)).toBe(192);
  });
});

describe("paneWidthCeiling", () => {
  // The reachable ceiling is what a divider announces as `aria-valuemax`
  // (PR #2632 R1): reporting the static max while the fraction bound holds the
  // pane below it describes a range the operator cannot reach.
  test("is the static max until the container is measured", () => {
    expect(paneWidthCeiling(BOUNDS)).toBe(640);
    expect(paneWidthCeiling({ ...BOUNDS, containerWidth: 0, maxFraction: 0.6 })).toBe(640);
  });

  test("drops to the container fraction once that is tighter", () => {
    expect(paneWidthCeiling({ ...BOUNDS, containerWidth: 800, maxFraction: 0.6 })).toBe(480);
  });

  test("never drops below min, which is why min stays reachable at any width", () => {
    expect(paneWidthCeiling({ ...BOUNDS, containerWidth: 200, maxFraction: 0.6 })).toBe(192);
  });

  test("bounds what clampPaneWidth will actually return", () => {
    const narrow = { ...BOUNDS, containerWidth: 800, maxFraction: 0.6 };
    expect(clampPaneWidth(10_000, narrow)).toBe(Math.round(paneWidthCeiling(narrow)));
  });
});

describe("loadPaneWidth", () => {
  test("returns a stored in-range width", () => {
    savePaneWidth(KEY, 384);
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(384);
  });

  test("falls back to the default when nothing is stored", () => {
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(256);
  });

  test("falls back to the default on an unparsable value", () => {
    localStorage.setItem(KEY, "not-a-number");
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(256);
    localStorage.setItem(KEY, "");
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(256);
  });

  test("falls back to the default — not to the nearest edge — when out of range", () => {
    // Out of range means the BOUNDS moved since the value was written, so the
    // operator never chose this width under the current layout. The current
    // default beats the nearest legal edge of a preference from a layout that
    // no longer exists.
    localStorage.setItem(KEY, "5000");
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(256);
    localStorage.setItem(KEY, "10");
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(256);
  });
});

describe("savePaneWidth", () => {
  test("round-trips through storage as whole pixels", () => {
    savePaneWidth(KEY, 321.7);
    expect(localStorage.getItem(KEY)).toBe("322");
    expect(loadPaneWidth(KEY, 256, BOUNDS)).toBe(322);
  });

  test("writes nothing for a non-finite width", () => {
    savePaneWidth(KEY, Number.NaN);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
