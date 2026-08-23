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
 * The largest width actually REACHABLE under `bounds` right now — `max`, lowered
 * by the container fraction once the container has been measured.
 *
 * Exported because the reachable ceiling is not an implementation detail of the
 * clamp: it is what a divider must report as `aria-valuemax`. Announcing the
 * static `max` while the fraction bound holds the pane well below it tells a
 * screen-reader user a range that does not exist (PR #2632 R1).
 *
 * Precedence when the container is too narrow for `min` to fit inside
 * `maxFraction`: **`min` wins.** The fraction bound protects the sibling pane's
 * usable area, but a pane narrower than `min` is illegible rather than merely
 * cramped, and an illegible pane helps nobody. At that point the window is too
 * small for the split regardless of where the divider sits — so the ceiling
 * never drops below `min`, and `min` therefore stays reachable at every
 * container width, which is why there is no matching `paneWidthFloor`.
 */
export function paneWidthCeiling(bounds: PaneWidthBounds): number {
  const { min, max, containerWidth = 0, maxFraction = 1 } = bounds;
  const ceiling = containerWidth > 0 ? Math.min(max, containerWidth * maxFraction) : max;
  return Math.max(min, ceiling);
}

/**
 * Clamp a requested pane width into `bounds`, rounded to whole pixels.
 *
 * A non-finite `requested` (a corrupt stored value, a `NaN` from arithmetic on
 * an unmeasured box) collapses to `min` rather than propagating: every caller
 * feeds this straight into a `width` style, where `NaN` renders as "no width
 * constraint at all" and silently un-does the split.
 */
export function clampPaneWidth(requested: number, bounds: PaneWidthBounds): number {
  if (!Number.isFinite(requested)) return bounds.min;
  return Math.round(Math.min(paneWidthCeiling(bounds), Math.max(bounds.min, requested)));
}

/**
 * Read a persisted pane width, or `null` when this surface cannot use what is
 * stored: no stored value, a value that does not parse as a finite number, or a
 * value outside `bounds`.
 *
 * Out-of-range is treated as absent rather than clamped on purpose. A stored
 * value outside the bounds means the bounds moved (a redesign, a renamed key
 * reused, hand-edited storage) — the operator never chose that width under the
 * current layout, so the current default is a better answer than the nearest
 * legal edge of a preference from a layout that no longer exists.
 *
 * Never throws: `localStorage` access itself raises in a sandboxed iframe and
 * under some privacy modes, and a pane width is not worth failing a render over.
 *
 * **Why this returns `null` rather than a fallback (mt#4261).** `loadPaneWidth`
 * below is the ergonomic form and remains what a host with a CONSTANT default
 * should call. A host whose default is DERIVED from something live — the peek's
 * default is a function of viewport width — cannot use it: seeding state with
 * `loadPaneWidth(key, derivedDefault, …)` freezes the derived value at first
 * render, so "no preference set" silently stops tracking the thing it derives
 * from. Such a host needs to know whether a preference EXISTS, which a value
 * that is indistinguishable from a legitimately-stored one cannot tell it.
 */
export function readPaneWidth(
  storageKey: string,
  bounds: Pick<PaneWidthBounds, "min" | "max">
): number | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    return null;
  }
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < bounds.min || parsed > bounds.max) return null;
  return Math.round(parsed);
}

/**
 * Read a persisted pane width, falling back to `fallback` for anything this
 * surface cannot use. Thin wrapper over `readPaneWidth` — see its doc for the
 * unusable cases and why out-of-range is treated as absent.
 */
export function loadPaneWidth(
  storageKey: string,
  fallback: number,
  bounds: Pick<PaneWidthBounds, "min" | "max">
): number {
  return readPaneWidth(storageKey, bounds) ?? fallback;
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
