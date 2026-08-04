/**
 * Pane-width arithmetic and persistence for draggable pane dividers (mt#3701).
 *
 * Kept separate from the components that use it so the part that DECIDES a
 * width is pure. The component suite runs under happy-dom, which has no layout
 * engine — every `getBoundingClientRect()` reads 0 — so anything that measures
 * a real box has to be verified over CDP (`src/cockpit/CLAUDE.md` §Asserting
 * layout geometry). Clamping and localStorage round-tripping are exactly the
 * part a unit test CAN settle, which is why they live here rather than inline
 * in `PaneDivider` or its host.
 *
 * @see components/PaneDivider.tsx — the interaction surface
 * @see components/session-film/SessionFilm.tsx — the first host
 */

export interface PaneWidthBounds {
  /** Smallest width the sized pane may take, in px. */
  min: number;
  /** Largest width the sized pane may take, in px. */
  max: number;
  /**
   * Measured width of the container the two panes share. `0` (the default)
   * means "not measured yet" and disables the fraction bound below — a first
   * render, before the ResizeObserver has reported, must not clamp everything
   * to zero.
   */
  containerWidth?: number;
  /**
   * Largest share of `containerWidth` the sized pane may take, so a narrow
   * window cannot leave its sibling with no usable area. Defaults to `1`
   * (no fraction bound).
   */
  maxFraction?: number;
}

/**
 * Clamp a requested pane width into `bounds`, rounded to whole pixels.
 *
 * Precedence when the container is too narrow for `min` to fit inside
 * `maxFraction`: **`min` wins.** The fraction bound protects the sibling pane's
 * usable area, but a pane narrower than `min` is illegible rather than merely
 * cramped, and an illegible pane helps nobody. At that point the window is too
 * small for the split regardless of where the divider sits.
 *
 * A non-finite `requested` (a corrupt stored value, a `NaN` from arithmetic on
 * an unmeasured box) collapses to `min` rather than propagating: every caller
 * feeds this straight into a `width` style, where `NaN` renders as "no width
 * constraint at all" and silently un-does the split.
 */
export function clampPaneWidth(requested: number, bounds: PaneWidthBounds): number {
  const { min, max, containerWidth = 0, maxFraction = 1 } = bounds;
  if (!Number.isFinite(requested)) return min;
  const ceiling = containerWidth > 0 ? Math.min(max, containerWidth * maxFraction) : max;
  return Math.round(Math.max(min, Math.min(ceiling, requested)));
}

/**
 * Read a persisted pane width, falling back to `fallback` for anything this
 * surface cannot use: no stored value, a value that does not parse as a finite
 * number, or a value outside `bounds`.
 *
 * Out-of-range is treated as absent rather than clamped on purpose. A stored
 * value outside the bounds means the bounds moved (a redesign, a renamed key
 * reused, hand-edited storage) — the operator never chose that width under the
 * current layout, so the current default is a better answer than the nearest
 * legal edge of a preference from a layout that no longer exists.
 *
 * Never throws: `localStorage` access itself raises in a sandboxed iframe and
 * under some privacy modes, and a pane width is not worth failing a render over.
 */
export function loadPaneWidth(
  storageKey: string,
  fallback: number,
  bounds: Pick<PaneWidthBounds, "min" | "max">
): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    return fallback;
  }
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < bounds.min || parsed > bounds.max) return fallback;
  return Math.round(parsed);
}

/** Persist a pane width. Silently no-ops when storage is unavailable. */
export function savePaneWidth(storageKey: string, width: number): void {
  if (!Number.isFinite(width)) return;
  try {
    localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // intentional-swallow: a pane width that fails to persist costs the
    // operator one re-drag next load; a throw here would take down the render.
  }
}
