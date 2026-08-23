/**
 * Peek width — the operator's preference for how much of the page the side peek
 * covers (mt#4261).
 *
 * ## Why this is a preference and not a constant
 *
 * The pane's width has been a single global constant since mt#3694, and it has
 * already needed tuning once: mt#4123 replaced a flat `26rem` with
 * `min(26rem, 45vw)` because at a ~620px window the pane covered 67% of the page
 * and sliced the text behind it mid-word. That fix is right and stays here as
 * the DEFAULT — but a width derived from the viewport cannot know what is INSIDE
 * the pane, and a one-line ask and a conversation body want different widths at
 * the same window size. Only the operator knows which they are reading, so the
 * control belongs to them rather than to a better constant.
 *
 * ## Two values, deliberately
 *
 * `storedWidth` is the operator's PREFERENCE, bounded only by min/max, and it is
 * `null` until they express one. `widthPx` is what RENDERS, additionally bounded
 * by the viewport and by how many panes are open. Narrowing the window therefore
 * narrows the panes without overwriting a wider preference set at a larger size —
 * the same split `SessionFilm` uses for the film's ribbon (mt#3701), and the
 * reason `readPaneWidth` had to grow a null-returning form: this host's default
 * is DERIVED from the live viewport, so it cannot be frozen into state at first
 * render the way a constant default can.
 *
 * ## The clamp is on the ASSEMBLY, not the pane
 *
 * The peek is a row of panes, not one drawer: the hold gesture lets N sit side
 * by side. A per-pane ceiling would let two held panes at the ceiling cover
 * twice what one is allowed to, which is exactly the case mt#4123 was filed
 * about. So the fraction bound is divided by the pane count before it reaches
 * `paneWidthCeiling` — the ceiling is a share of the viewport for the whole
 * assembly, and each pane gets an equal part of it.
 *
 * @see lib/pane-width.ts — the clamp/persist arithmetic, shared with the film
 * @see components/PaneDivider.tsx — the interaction surface
 */
import { useCallback, useEffect, useState } from "react";
import {
  clampPaneWidth,
  paneWidthCeiling,
  readPaneWidth,
  savePaneWidth,
  type PaneWidthBounds,
} from "./pane-width";

// localStorage key name, not a credential — gitleaks generic-api-key
// false-positives on the `*KEY = "<string>"` shape (mirrors lib/tabs.tsx).
export const PEEK_WIDTH_STORAGE_KEY = "cockpit.peek.width.v1"; // gitleaks:allow

/**
 * The narrowest a pane may be dragged. Below this the pane stops being a glance
 * column and starts being a sliver — mt#4123 designed the interior against a
 * ~416px column, and its padding, header chrome and two-line entity labels are
 * what set this floor.
 */
export const MIN_PEEK_WIDTH_PX = 280;

/**
 * The widest a SINGLE pane may be dragged, before the viewport share below
 * applies. A peek wider than this is a page, and the pane header already carries
 * an "Open as page" control for that.
 */
export const MAX_PEEK_WIDTH_PX = 800;

/** `26rem` — the pane's width since mt#3694, and still its default at any window with room for it. */
export const DEFAULT_PEEK_WIDTH_PX = 416;

/** The `45vw` half of mt#4123's `min(26rem, 45vw)`, kept as the default's shape. */
export const DEFAULT_PEEK_VIEWPORT_FRACTION = 0.45;

/**
 * Share of the viewport the whole assembly may occupy once a preference is set.
 *
 * 0.62 rather than a rounder number because it is derived from what already
 * ships: two held panes at the 416px default on a 1440px window take 832px, or
 * 57.8%, and `PeekHost`'s own comment defends that as leaving the page usable.
 * A ceiling below it would silently narrow today's two-pane layout, which is a
 * behavior change this task did not set out to make; a little above it lets the
 * operator go slightly wider than the default without reaching a cliff.
 */
export const MAX_ASSEMBLY_VIEWPORT_FRACTION = 0.62;

/**
 * Absolute floor on what the page behind keeps, in px — a second ceiling on the
 * assembly, applied alongside the fraction above.
 *
 * A fraction alone is not enough, and the live check is what showed it: at a
 * 620px window 62% leaves the page 236px, which is the sliced-mid-word state
 * mt#4123 was filed for, reached this time by the operator's own drag rather
 * than by a constant. 300px is the same threshold
 * `scripts/verify-peek-pane-layout.ts` already encodes for "the page behind is
 * still readable prose rather than fragments" — taken from there rather than
 * picked, so the two cannot drift apart.
 *
 * This bounds what RENDERS, never what is STORED: a preference set on a wide
 * monitor is preserved intact and comes back at full width when the window
 * grows again.
 */
export const MIN_PAGE_COLUMN_PX = 300;

/**
 * The width a pane renders at when the operator has expressed no preference —
 * mt#4123's `min(26rem, 45vw)`, in a number rather than a CSS expression so the
 * divider has something to report and to drag from.
 *
 * A non-positive or non-finite viewport (an unmeasured first frame, a headless
 * environment with no layout) falls back to the full default rather than to
 * zero: a pane that renders at 0px is indistinguishable from a broken peek.
 */
export function defaultPeekWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return DEFAULT_PEEK_WIDTH_PX;
  return Math.round(
    Math.min(DEFAULT_PEEK_WIDTH_PX, viewportWidth * DEFAULT_PEEK_VIEWPORT_FRACTION)
  );
}

/**
 * The narrowest a pane may go at this viewport — `MIN_PEEK_WIDTH_PX`, except on
 * a window too narrow for it, where the responsive default wins.
 *
 * Without this, the floor would make the pane WIDER than today on a narrow
 * window: `pane-width.ts` documents that `min` beats the fraction bound, so a
 * flat 280px floor would render 280 where mt#4123's `45vw` renders 225 on a
 * 500px window — a peek taking 56% of the page instead of 45%, which is the
 * direction mt#4123 exists to prevent. Tying the floor to the default keeps the
 * announced range coherent too: `aria-valuenow` can never sit below
 * `aria-valuemin`.
 */
export function peekMinWidth(viewportWidth: number): number {
  return Math.min(MIN_PEEK_WIDTH_PX, defaultPeekWidth(viewportWidth));
}

/**
 * Render bounds for ONE pane of an assembly of `paneCount`, at `viewportWidth`.
 *
 * `paneCount` is floored at 1 so a caller that asks about an empty assembly gets
 * the single-pane answer instead of a division by zero.
 *
 * **This does narrow one case that ships today, deliberately.** Two held panes
 * at the default take 90% of an 800px window, because the default is per-pane
 * and knows nothing about how many are open — mt#4123 checked the two-pane case
 * only at 1440, where 832 of 1440 genuinely does leave the page usable. Dividing
 * the fraction by the pane count is what makes "the page keeps a majority
 * column" hold at every width AND every pane count rather than at the one
 * combination that was measured. At 1440 the two-pane default is untouched
 * (446px of headroom against a 416px default), so the case that WAS reasoned
 * about is preserved exactly.
 */
export function peekWidthBounds(paneCount: number, viewportWidth: number): PaneWidthBounds {
  const panes = Math.max(1, paneCount);
  const measured = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  // The reserve is expressed through `max` rather than through `maxFraction`
  // because it is ABSOLUTE — a fixed number of pixels for the page, not a share
  // of the window. Folding it into the fraction would make it shrink with the
  // window, which is the opposite of what a readability floor is for.
  const reserveCeiling = measured > 0 ? (measured - MIN_PAGE_COLUMN_PX) / panes : MAX_PEEK_WIDTH_PX;
  return {
    min: peekMinWidth(viewportWidth),
    max: Math.min(MAX_PEEK_WIDTH_PX, Math.max(0, reserveCeiling)),
    containerWidth: measured,
    maxFraction: MAX_ASSEMBLY_VIEWPORT_FRACTION / panes,
  };
}

/**
 * The width a pane actually renders at: the operator's preference clamped into
 * `peekWidthBounds`, or the responsive default when they have none.
 *
 * Pure, so the whole width policy is testable without a DOM — which matters
 * here, because the component suite runs under happy-dom and has no layout
 * engine to measure a real viewport with.
 */
export function resolvePeekWidth(
  storedWidth: number | null,
  paneCount: number,
  viewportWidth: number
): number {
  const bounds = peekWidthBounds(paneCount, viewportWidth);
  if (storedWidth === null) return clampPaneWidth(defaultPeekWidth(viewportWidth), bounds);
  return clampPaneWidth(storedWidth, bounds);
}

/**
 * Viewport width, tracked across resizes.
 *
 * `window.innerWidth` rather than a `ResizeObserver` on the host: the peek is
 * `fixed inset-y-0 right-0`, so the thing it competes with for space IS the
 * viewport, and there is no intermediate container whose box would be a truer
 * measure. Seeded synchronously so the first paint is already correct.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    // Re-measure on attach as well as on resize: a window resized between the
    // initial render and this effect would otherwise leave the seeded value
    // stale until the next resize event.
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return width;
}

export interface PeekWidthController {
  /** What the pane should render at, in px. */
  widthPx: number;
  /** Reported to assistive tech as the range's floor. */
  minPx: number;
  /** The REACHABLE ceiling right now, not the static max — see `paneWidthCeiling`. */
  maxPx: number;
  /** Record a dragged/stepped width as the operator's preference. */
  setWidth: (nextWidthPx: number) => void;
  /** Forget the preference, returning to the responsive default. */
  resetWidth: () => void;
  /**
   * Clamp a LIVE drag value to what the pane may actually render right now,
   * without recording anything (mt#4274).
   *
   * The in-flight width of a drag is not state — it is 60-120 values per second
   * that exist only until the pointer comes up. Routing them through `setWidth`
   * puts them in React state on the host, which re-renders every pane body
   * beneath it: measured at 11.82ms of scripting per pointermove against a
   * 16.7ms frame budget, with the body accounting for 498 of a pane's 518
   * elements. React's own guidance is to fix that structurally rather than
   * memoize around it — *"Prefer local state and don't lift state up any
   * further than necessary"* (https://react.dev/reference/react/memo) — so the
   * host writes these straight to a CSS custom property and commits once on
   * release. This is the clamp that path needs, and it is deliberately the
   * RENDER clamp: the preference clamp in `setWidth` is a different bound.
   */
  previewWidth: (requestedPx: number) => number;
}

/**
 * The peek's width state.
 *
 * Note what `resetWidth` does: it CLEARS the preference rather than storing the
 * current default. Storing it would freeze today's viewport-derived number into
 * a preference the operator never expressed, so the pane would stop responding
 * to window size from the moment they pressed Home.
 */
export function usePeekWidth(paneCount: number): PeekWidthController {
  const viewportWidth = useViewportWidth();
  const [storedWidth, setStoredWidth] = useState<number | null>(() =>
    readPaneWidth(PEEK_WIDTH_STORAGE_KEY, {
      min: MIN_PEEK_WIDTH_PX,
      max: MAX_PEEK_WIDTH_PX,
    })
  );

  const bounds = peekWidthBounds(paneCount, viewportWidth);
  const widthPx = resolvePeekWidth(storedWidth, paneCount, viewportWidth);
  const maxPx = Math.round(paneWidthCeiling(bounds));

  const setWidth = useCallback((nextWidthPx: number) => {
    // Clamped to the STATIC min/max, NOT to the viewport-derived render bounds:
    // those are about the window in front of the operator right now, and folding
    // them in here would overwrite a preference set on a wide monitor the first
    // time they dragged in a narrow window.
    const next = clampPaneWidth(nextWidthPx, {
      min: MIN_PEEK_WIDTH_PX,
      max: MAX_PEEK_WIDTH_PX,
    });
    setStoredWidth(next);
    savePaneWidth(PEEK_WIDTH_STORAGE_KEY, next);
  }, []);

  const resetWidth = useCallback(() => {
    setStoredWidth(null);
    try {
      localStorage.removeItem(PEEK_WIDTH_STORAGE_KEY);
    } catch {
      // intentional-swallow: storage is unavailable in a sandboxed iframe and
      // under some privacy modes. The in-memory reset above already took
      // effect; a throw here would take down the render for a pane width.
    }
  }, []);

  // Deliberately NOT a `useCallback`: it closes over `bounds`, which is derived
  // from the live viewport and the pane count, and a memoized version would go
  // stale exactly when the window is resized mid-drag. `PaneDivider` reads its
  // callbacks through a ref refreshed every render, so a fresh closure per
  // render is what that seam already expects.
  const previewWidth = (requestedPx: number) => clampPaneWidth(requestedPx, bounds);

  // The REACHABLE floor and ceiling, not the static constants: both are what the
  // divider must announce, for the same reason PR #2632 R1 gave for the ceiling —
  // a range the pane cannot actually reach is a range that does not exist.
  return { widthPx, minPx: Math.round(bounds.min), maxPx, setWidth, resetWidth, previewWidth };
}
