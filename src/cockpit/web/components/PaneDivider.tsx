/**
 * PaneDivider — a draggable vertical divider that resizes the pane on ONE side
 * of it (mt#3701; the side became a choice in mt#4261).
 *
 * `resizes` names which side, and defaults to `"left"` — the original and only
 * behavior until the peek adopted this component. A right-anchored surface (the
 * entity side peek) needs the mirror: its divider sits at the assembly's left
 * edge and dragging LEFT must WIDEN the pane. That is a sign flip on one delta,
 * not a second component, because everything else — the grip, the drag
 * bookkeeping, the separator semantics, the reset gestures — is identical.
 *
 * Presentational and stateless about the width itself: it reports a REQUESTED
 * width and the host decides what to do with it (clamp, persist, ignore). That
 * split is what lets the host hold a stored preference that is wider than the
 * current window without the divider having to know anything about containers
 * — see `lib/pane-width.ts`.
 *
 * The affordance is deliberately visible at rest, not a hidden hit area. A
 * resize target the operator has to discover by sweeping the mouse across a
 * seam is a feature only the person who wrote it knows about; the grip mark
 * below reads as a handle before it is touched, and the whole divider signals
 * on hover, focus, and drag.
 *
 * Written generically (no film vocabulary) because a second host is plausible —
 * the shell rail and the conversation panes have the same shape. It is NOT
 * adopted anywhere else yet; that is a follow-up, not a claim this component
 * already makes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/** Arrow-key step, in px. */
export const PANE_DIVIDER_STEP_PX = 16;
/** Shift+arrow step, in px — coarse enough to cross the range in a few presses. */
export const PANE_DIVIDER_COARSE_STEP_PX = 64;

export interface PaneDividerProps {
  /** Current rendered width of the pane this divider sizes, in px. */
  value: number;
  /**
   * Which side of the divider the sized pane is on. `"left"` (the default) is
   * the film's ribbon/stage split; `"right"` is the right-anchored peek, where
   * dragging left widens. Only the drag/arrow sign differs.
   */
  resizes?: "left" | "right";
  /**
   * `id` (or space-separated ids) of the element(s) this divider sizes, for
   * `aria-controls`. The WAI-ARIA Window Splitter pattern lists it among the
   * required attributes; it is optional here only because a host whose sized
   * element has no id would otherwise have to invent one, and an `aria-controls`
   * pointing at nothing is worse than its absence.
   */
  controls?: string;
  /** Reported to assistive tech as the range; the host still owns the clamp. */
  min: number;
  max: number;
  /**
   * Requested new width for the sized pane, in px. Called continuously during a
   * drag — the host is expected to clamp, and may render something other than
   * what was asked for.
   */
  onChange: (nextWidthPx: number) => void;
  /** Restore the host's default width (double-click, or `Home`). */
  onReset: () => void;
  /** Accessible name, e.g. "Resize the event ribbon". */
  label: string;
  className?: string;
  "data-testid"?: string;
}

export function PaneDivider({
  value,
  min,
  max,
  resizes = "left",
  controls,
  onChange,
  onReset,
  label,
  className,
  "data-testid": testId,
}: PaneDividerProps) {
  // +1 when the sized pane is to the LEFT (dragging right widens it), -1 when it
  // is to the RIGHT (dragging left widens it). The only thing `resizes` changes.
  const widenSign = resizes === "right" ? -1 : 1;
  const [isDragging, setIsDragging] = useState(false);
  /** Pointer origin + the width at that moment, so a drag stays ABSOLUTE. */
  const dragOriginRef = useRef<{ clientX: number; widthPx: number } | null>(null);

  // `onChange` through a ref so the drag effect below depends on `isDragging`
  // ALONE. A host that passes an inline arrow function would otherwise churn the
  // effect on every move — tearing down the window listeners and re-writing the
  // document-level cursor/selection overrides mid-drag.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only: a right-click or a middle-click on the seam should
      // do what it normally does, not start a resize the operator can't see.
      if (e.button !== 0) return;
      e.preventDefault();
      dragOriginRef.current = { clientX: e.clientX, widthPx: value };
      setIsDragging(true);
    },
    [value]
  );

  useEffect(() => {
    if (!isDragging) return;

    function handleMove(e: PointerEvent) {
      const origin = dragOriginRef.current;
      if (!origin) return;
      onChangeRef.current(origin.widthPx + widenSign * (e.clientX - origin.clientX));
    }
    function handleEnd() {
      dragOriginRef.current = null;
      setIsDragging(false);
    }

    // Listeners on `window`, not pointer capture on the element: for all but the
    // first few pixels of a drag the pointer is nowhere near this 6px-wide
    // divider, and window listeners deliver those moves in every environment —
    // including happy-dom, where `setPointerCapture` is not implemented.
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);

    // Hold the resize cursor and suppress selection for the whole drag. Without
    // these, dragging across the panes flickers the I-beam and paints a text
    // selection over whatever the pointer crosses.
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    // `widenSign` joins `isDragging` here without reintroducing the churn the
    // `onChangeRef` comment above avoids: it is derived from a prop that names
    // the host's fixed geometry, so it is constant for the life of a mount. An
    // inline `onChange` arrow changes identity every render; this does not.
  }, [isDragging, widenSign]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? PANE_DIVIDER_COARSE_STEP_PX : PANE_DIVIDER_STEP_PX;
      let next: number | null = null;
      // The APG defines the arrow keys by where the SPLITTER moves, not by
      // whether the pane grows — so on a right-anchored host ArrowLeft is the
      // widening direction, which `widenSign` carries.
      if (e.key === "ArrowRight") next = value + widenSign * step;
      else if (e.key === "ArrowLeft") next = value - widenSign * step;
      else if (e.key !== "Home") return;

      e.preventDefault();
      // `stopPropagation` is load-bearing, not defensive tidiness: a host can
      // register its own window-level arrow-key handler (SessionFilm steps the
      // playhead on Left/Right), and React attaches its listeners at the root
      // container — BELOW window — so stopping here is what keeps a resize
      // keystroke from also driving the host's shortcut.
      e.stopPropagation();
      if (next === null) onReset();
      else onChange(next);
    },
    [value, widenSign, onChange, onReset]
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={isDragging ? "true" : undefined}
      data-testid={testId}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group relative flex w-1.5 shrink-0 cursor-col-resize touch-none select-none items-center justify-center outline-none",
        className
      )}
    >
      {/* The seam itself — replaces the border this divider stands in for. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 w-px bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-data-[dragging=true]:bg-ring"
      />
      {/* The grip. Visible at rest (that is the affordance), signal-colored on
          approach — the same at-rest-neutral / on-approach-accent register the
          rest of the cockpit's interactive chrome uses. */}
      <span
        aria-hidden="true"
        data-testid={testId ? `${testId}-grip` : undefined}
        className="pointer-events-none relative h-8 w-1 rounded-full bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-data-[dragging=true]:bg-ring"
      />
    </div>
  );
}
