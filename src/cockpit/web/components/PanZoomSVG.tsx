/**
 * PanZoomSVG — lightweight pan/zoom wrapper for a fixed-coordinate SVG.
 *
 * Implementation choice (mt#2380): custom viewBox handler, dep-free. The
 * interaction surface is small (wheel zoom toward cursor + pointer drag), so a
 * library is not worth the dependency. Zero new deps, no license audit needed.
 *
 * Aspect-ratio correctness (mt#2380 R1):
 *   The SVG uses preserveAspectRatio="none" so the viewBox maps linearly onto the
 *   container (pointer→SVG mapping is trivial: it fills the container edge-to-edge).
 *   "none" stretches the viewBox to the container, so to AVOID distortion the
 *   viewBox aspect MUST always equal the container aspect — i.e. vbH = vbW * (cH/cW).
 *   Earlier the fit computed vbH from the container but zoom reset it to the BOARD
 *   aspect, which stretched circles into ovals on any non-1280×820 container. Now
 *   every viewBox we produce derives its height from the tracked container aspect,
 *   so x/y scale stay equal and there is no distortion at any zoom.
 *
 * Default framing: fit-width (full board width, height matched to the container
 * aspect, vertically centered) with pan/zoom for detail.
 *
 * Resize policy (mt#2380 R1):
 *   `userInteractedRef` gates auto-refit. Before the user zooms/pans, the board
 *   auto-refits on container resize. After the first manual interaction, the
 *   user's framing persists across resizes (only its height is corrected to the
 *   new aspect so it never distorts).
 *
 * Stale-closure safety (mt#2380 R1):
 *   The wheel listener is attached once and reads the live viewBox via
 *   `viewBoxRef` / inside the setViewBox updater (focal point passed as
 *   fractions), so rapid wheel events never compute focus from a stale viewBox.
 *
 * a11y: +/-/reset buttons are keyboard-focusable and ARIA-labelled; the SVG has
 * role="img" with the supplied aria-label.
 *
 * prefers-reduced-motion: viewBox changes are instant (no tween), so there is no
 * motion to gate; the SVG children's vsm-* CSS animations remain gated by the
 * global reduced-motion rule in index.css.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ambient camera life (mt#3226 SC 4 — session film aliveness pass): a slow
 * viewBox drift/zoom-breathing wobble around the current fit, PAUSED the
 * instant the user pans/zooms manually (reuses `userInteractedRef` — the
 * SAME ref that already gates auto-refit-on-resize). The CALLER decides
 * `enabled` (SessionFilmStage.tsx passes `!reducedMotion`) — PanZoomSVG
 * itself stays reduced-motion-agnostic, matching this component's existing
 * "resize policy" ownership split.
 */
interface AmbientDriftOptions {
  enabled: boolean;
  /** Position-drift amplitude, board coordinate units. */
  amplitudePx: number;
  /** One full drift cycle, ms. */
  periodMs: number;
}

/**
 * Camera-follow / growing-bounding-box auto-fit (mt#3231 SC 5 — the RFC's
 * A3 "camera-follow" rung, pulled forward). HONEST, event-driven motion
 * (unlike `AmbientDriftOptions` above): the bounds this eases toward exist
 * because the caller's real content actually grew, not a decorative loop —
 * see `SessionFilmStage.tsx` for how it derives `bounds` from the touched-
 * set's live positions every frame.
 */
interface GrowingBoundsOptions {
  /** World-space bounding box of the content to keep framed, or `null` when there's nothing to fit yet (no-op). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** World-space padding added around `bounds` before fitting. */
  padding: number;
  /** Ease duration toward a new fit, ms. `0` snaps instantly instead of tweening — the reduced-motion degrade (matches every other motion class in this codebase: discrete state change, not a zeroed-duration tween). */
  easeMs: number;
}

interface PanZoomSVGProps {
  /** Intrinsic coordinate width of the SVG drawing area. */
  boardWidth: number;
  /** Intrinsic coordinate height of the SVG drawing area. */
  boardHeight: number;
  /** Accessible label for the SVG region. */
  ariaLabel: string;
  /** Ambient drift/zoom-breathing (mt#3226 SC 4) — omit or `enabled: false` for the plain fit-and-hold framing. */
  ambientDrift?: AmbientDriftOptions;
  /** Camera-follow auto-fit (mt#3231 SC 5) — omit for the plain fit-and-hold framing (existing behavior, unchanged). */
  growingBounds?: GrowingBoundsOptions;
  className?: string;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.15; // fractional zoom per button click
const WHEEL_SENSITIVITY = 0.001;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a value between lo and hi. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Fit-width viewBox: the board's full width fills the container; the height is
 * matched to the container aspect (cH/cW) so that with preserveAspectRatio="none"
 * there is no distortion. Vertically centered within the board.
 */
function fitViewBox(boardWidth: number, boardHeight: number, containerWidth: number, containerHeight: number): ViewBox {
  const aspect = containerHeight / containerWidth;
  const w = boardWidth;
  const h = w * aspect;
  return {
    x: 0,
    y: (boardHeight - h) / 2,
    w,
    h,
  };
}

/**
 * Fit-to-bounds viewBox (mt#3231 SC 5): the smallest no-distortion viewBox
 * (matching the container's own aspect, same invariant `fitViewBox` above
 * keeps) that contains `bounds` plus `padding` on every side, centered on
 * the bounds' own center — the camera-follow counterpart of `fitViewBox`'s
 * fixed full-board fit.
 */
function fitToBoundsViewBox(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding: number,
  containerWidth: number,
  containerHeight: number
): ViewBox {
  const containerAspect = containerHeight / containerWidth;
  const boundsW = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const boundsH = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  const boundsAspect = boundsH / boundsW;
  // Whichever dimension the bounds are relatively "taller"/"wider" than the
  // container in determines which one is the binding constraint — the SAME
  // "fit inside, don't crop" logic as CSS `object-fit: contain`.
  let w: number;
  let h: number;
  if (boundsAspect > containerAspect) {
    h = boundsH;
    w = h / containerAspect;
  } else {
    w = boundsW;
    h = w * containerAspect;
  }
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Ease-out-cubic — per interface-design motion guidance (exponential ease-out, no bounce/elastic). */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PanZoomSVG({
  boardWidth,
  boardHeight,
  ariaLabel,
  ambientDrift,
  growingBounds,
  className,
  children,
}: PanZoomSVGProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // ViewBox state. Initialized to the full board; the real fit is computed in the
  // layout effect once the container dimensions are known.
  const [viewBox, setViewBox] = useState<ViewBox>({
    x: 0,
    y: 0,
    w: boardWidth,
    h: boardHeight,
  });

  // Live mirror of viewBox so non-React event handlers (wheel) read fresh values
  // without re-attaching listeners on every change.
  const viewBoxRef = useRef<ViewBox>(viewBox);
  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // Tracked container size. Defaults to board dims so behavior is deterministic in
  // zero-size environments (JSDOM): aspect == board aspect there.
  const containerSizeRef = useRef<{ w: number; h: number }>({ w: boardWidth, h: boardHeight });

  // Has the user manually zoomed/panned? Gates resize auto-refit.
  const userInteractedRef = useRef(false);

  const applyFit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    containerSizeRef.current = { w: width, h: height };
    setViewBox(fitViewBox(boardWidth, boardHeight, width, height));
  }, [boardWidth, boardHeight]);

  useEffect(() => {
    applyFit();
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      containerSizeRef.current = { w: width, h: height };
      if (!userInteractedRef.current) {
        // Auto-refit until the user takes control.
        applyFit();
      } else {
        // Preserve the user's framing but correct the height to the new aspect so
        // preserveAspectRatio="none" never distorts.
        setViewBox((vb) => ({ ...vb, h: vb.w * (height / width) }));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [applyFit]);

  // -------------------------------------------------------------------------
  // Ambient camera life (mt#3226 SC 4): a slow drift/zoom-breathing wobble
  // RECOMPUTED FRESH from the current fit every tick (not compounded onto
  // itself — the camera breathes AROUND the fitted center, it doesn't
  // random-walk away from it). Ticks are skipped entirely once
  // `userInteractedRef.current` is true: "user pan/zoom always overrides
  // and pauses ambience" (spec) — checked live inside the tick, not just at
  // effect-setup time, so a mid-drift user interaction stops it immediately
  // on the NEXT tick without needing to tear down and restart the interval.
  // -------------------------------------------------------------------------
  const ambientStartRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!ambientDrift?.enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const tick = () => {
      if (userInteractedRef.current) return; // paused — the user is in control
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const fit = fitViewBox(boardWidth, boardHeight, width, height);
      const elapsed = Date.now() - ambientStartRef.current;
      const amp = ambientDrift.amplitudePx;
      const period = ambientDrift.periodMs;
      const dx = amp * Math.sin((2 * Math.PI * elapsed) / period);
      // Different period ratio for y — an organic (Lissajous-like) drift
      // path rather than a perfect circle.
      const dy = amp * Math.cos((2 * Math.PI * elapsed) / (period * 1.37));
      // Subtle zoom breathing — a small scale wobble around the SAME fit,
      // kept centered (adjusting x/y by half the size delta).
      const scaleWobble = 1 + 0.02 * Math.sin((2 * Math.PI * elapsed) / (period * 0.6));
      const w = fit.w * scaleWobble;
      const h = fit.h * scaleWobble;
      setViewBox({
        x: fit.x + dx - (w - fit.w) / 2,
        y: fit.y + dy - (h - fit.h) / 2,
        w,
        h,
      });
    };
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [ambientDrift?.enabled, ambientDrift?.amplitudePx, ambientDrift?.periodMs, boardWidth, boardHeight]);

  // -------------------------------------------------------------------------
  // Camera-follow / growing-bounding-box auto-fit (mt#3231 SC 5): eases the
  // viewBox toward fitting `growingBounds.bounds` — "the viewport auto-fits
  // the world's growing bounding box... a smooth camera that follows growth
  // (ease toward the new fit, don't snap)." Paused by the SAME
  // `userInteractedRef` the resize/ambient-drift logic already uses ("user
  // pan/zoom overrides and pauses auto-fit" — spec, extending the existing
  // override behavior rather than inventing a second one). `easeMs <= 0`
  // (the reduced-motion caller contract) snaps instantly instead of
  // tweening, matching every other motion class in this codebase.
  //
  // Rounded to the nearest world-unit for the dependency key: the touched-
  // set's live force-simulated positions drift continuously by fractions of
  // a pixel every tick: a raw-float key would restart the ease on every
  // single tick even when nothing meaningfully changed. A restart on every
  // GENUINE (>=1 world-unit) bounds change is intentional, not a bug — the
  // camera keeps re-aiming at a continuously-updating target as the world
  // evolves, which is exactly "follows growth."
  //
  // Zero-size backoff (mt#3231 review R1, BLOCKING): a self-rescheduling
  // `setTimeout` (not a bare `setInterval`) so the retry CADENCE can differ
  // from the tween cadence. While the container reports 0x0 (hidden tab,
  // `display:none` transition, not yet laid out at mount) we do NOT compute
  // a fit against 0x0 — we back off to `ZERO_SIZE_RETRY_MS`, a much slower
  // poll than the 50ms tween rate, so a long-hidden container doesn't spin a
  // tight do-nothing loop. The instant real dimensions appear, the fit
  // resumes at the normal 50ms cadence. `cancelled` + clearing the pending
  // timeout together are the cleanup this effect returns on every dep
  // change AND on unmount — belt-and-suspenders like the rest of this file
  // (see the ambient-drift interval's own cleanup above).
  // -------------------------------------------------------------------------
  const boundsKey = growingBounds?.bounds
    ? `${Math.round(growingBounds.bounds.minX)},${Math.round(growingBounds.bounds.minY)},${Math.round(growingBounds.bounds.maxX)},${Math.round(growingBounds.bounds.maxY)}`
    : null;
  useEffect(() => {
    // Narrow via a direct property check (not optional chaining) so `bounds`/
    // `padding`/`easeMs` destructure as definitely-non-null `const`s — safe
    // to reference from the nested `runTick` function declaration below
    // without repeated non-null assertions.
    if (!growingBounds || !growingBounds.bounds) return;
    const { bounds, padding, easeMs } = growingBounds;
    const el = containerRef.current;
    if (!el) return;

    const ZERO_SIZE_RETRY_MS = 250;
    const TWEEN_TICK_MS = 50;

    // The EASE ORIGIN (`start`) and its clock are resolved LAZILY, on the
    // first tick that sees a real (non-zero) container size — NOT read
    // once up front — so a container that hasn't laid out yet at effect-
    // setup time (its `getBoundingClientRect()` still reporting 0x0, e.g.
    // during initial mount) doesn't strand this effect with no interval to
    // ever retry from. Every ambient/resize path in this component already
    // re-reads `getBoundingClientRect()` per-tick for the same reason.
    let start: ViewBox | null = null;
    let startTime = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleTick = (delayMs: number) => {
      timeoutId = setTimeout(runTick, delayMs);
    };

    function runTick() {
      if (cancelled) return;
      if (userInteractedRef.current) return; // stopped for good — see module doc's resize-policy note
      // `el` is narrowed non-null above, but TS control-flow narrowing of a
      // `const` doesn't persist into a nested `function` DECLARATION
      // (unlike an arrow function) — safe by construction, since `el` is
      // never reassigned between the check above and every call here.
      const { width, height } = el!.getBoundingClientRect();
      if (width === 0 || height === 0) {
        // Not laid out yet (or genuinely hidden) — don't compute a fit
        // against 0x0. Retry at a slower cadence than the tween rate
        // instead of busy-polling at 20Hz while there's nothing to do.
        scheduleTick(ZERO_SIZE_RETRY_MS);
        return;
      }
      const target = fitToBoundsViewBox(bounds, padding, width, height);

      if (easeMs <= 0) {
        setViewBox(target);
        return; // converged — nothing left to schedule
      }

      if (start === null) {
        start = viewBoxRef.current;
        startTime = Date.now();
      }
      const t = Math.min(1, (Date.now() - startTime) / easeMs);
      const eased = easeOutCubic(t);
      setViewBox({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        w: start.w + (target.w - start.w) * eased,
        h: start.h + (target.h - start.h) * eased,
      });
      if (t < 1) scheduleTick(TWEEN_TICK_MS);
    }

    scheduleTick(0);
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
    // `boundsKey` is the intentional rounded proxy for `growingBounds.bounds`'s identity (see the comment above); padding/easeMs are the other two primitives this effect reads.
  }, [boundsKey, growingBounds?.padding, growingBounds?.easeMs]);

  // -------------------------------------------------------------------------
  // Zoom (focal point as fractions of the viewport; resolved against the LIVE
  // viewBox inside the updater so there is no stale-closure focal drift).
  // -------------------------------------------------------------------------

  const zoomByFraction = useCallback(
    (factor: number, fracX: number, fracY: number) => {
      userInteractedRef.current = true;
      const { w: cW, h: cH } = containerSizeRef.current;
      const aspect = cH / cW; // height/width — the no-distortion invariant
      setViewBox((vb) => {
        const currentScale = boardWidth / vb.w;
        const nextScale = clamp(currentScale * factor, MIN_SCALE, MAX_SCALE);
        if (nextScale === currentScale) return vb;
        const nextW = boardWidth / nextScale;
        const nextH = nextW * aspect; // aspect from CONTAINER, not board → no distortion
        const focalX = vb.x + fracX * vb.w;
        const focalY = vb.y + fracY * vb.h;
        const nextX = focalX - fracX * nextW;
        const nextY = focalY - fracY * nextH;
        return { x: nextX, y: nextY, w: nextW, h: nextH };
      });
    },
    [boardWidth]
  );

  const zoomCenter = useCallback((factor: number) => zoomByFraction(factor, 0.5, 0.5), [zoomByFraction]);

  // -------------------------------------------------------------------------
  // Wheel zoom — attached once; reads live state via fractions (no stale closure).
  // -------------------------------------------------------------------------

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;
      // deltaY > 0 = scroll down = zoom out; < 0 = zoom in.
      const factor = 1 - e.deltaY * WHEEL_SENSITIVITY;
      zoomByFraction(factor, fracX, fracY);
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [zoomByFraction]);

  // -------------------------------------------------------------------------
  // Pointer drag (pan) — reads the live viewBox via the ref (deps-free callbacks).
  // -------------------------------------------------------------------------

  const dragRef = useRef<{ startX: number; startY: number; startVBX: number; startVBY: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return; // primary button / single touch only
    e.currentTarget.setPointerCapture(e.pointerId);
    const vb = viewBoxRef.current;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startVBX: vb.x,
      startVBY: vb.y,
    };
    userInteractedRef.current = true;
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vb = viewBoxRef.current;
    const dx = ((e.clientX - dragRef.current.startX) / rect.width) * vb.w;
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * vb.h;
    setViewBox((cur) => ({
      ...cur,
      x: dragRef.current!.startVBX - dx,
      y: dragRef.current!.startVBY - dy,
    }));
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // -------------------------------------------------------------------------
  // Button controls
  // -------------------------------------------------------------------------

  const handleZoomIn = useCallback(() => zoomCenter(1 + ZOOM_STEP), [zoomCenter]);
  const handleZoomOut = useCallback(() => zoomCenter(1 / (1 + ZOOM_STEP)), [zoomCenter]);
  const handleReset = useCallback(() => {
    userInteractedRef.current = false;
    const el = containerRef.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        containerSizeRef.current = { w: width, h: height };
        setViewBox(fitViewBox(boardWidth, boardHeight, width, height));
        return;
      }
    }
    // Fallback (JSDOM / zero-size container): restore the full-board view.
    setViewBox({ x: 0, y: 0, w: boardWidth, h: boardHeight });
  }, [boardWidth, boardHeight]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const viewBoxAttr = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;

  return (
    <div
      ref={containerRef}
      className={cn("relative flex-1 min-w-0 min-h-0 overflow-hidden", className)}
      data-testid="pan-zoom-svg-container"
      data-ambient-drift={ambientDrift?.enabled ? "true" : undefined}
    >
      {/* Zoom controls — docked top-right, keyboard-focusable */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1" role="group" aria-label="Zoom controls">
        <button
          type="button"
          onClick={handleZoomIn}
          aria-label="Zoom in"
          className={cn(
            "w-7 h-7 rounded text-xs font-mono font-semibold",
            "bg-card border border-border text-foreground",
            "hover:bg-secondary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "leading-none flex items-center justify-center"
          )}
        >
          +
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          aria-label="Zoom out"
          className={cn(
            "w-7 h-7 rounded text-xs font-mono font-semibold",
            "bg-card border border-border text-foreground",
            "hover:bg-secondary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "leading-none flex items-center justify-center"
          )}
        >
          −
        </button>
        <button
          type="button"
          onClick={handleReset}
          aria-label="Reset to fit-width view"
          title="Reset / fit to width"
          className={cn(
            "w-7 h-7 rounded text-[9px] font-mono font-semibold",
            "bg-card border border-border text-muted-foreground",
            "hover:bg-secondary hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "leading-none flex items-center justify-center"
          )}
        >
          ⊡
        </button>
      </div>

      {/* SVG */}
      <svg
        ref={svgRef}
        viewBox={viewBoxAttr}
        preserveAspectRatio="none"
        className="w-full h-full block cursor-grab active:cursor-grabbing"
        role="img"
        aria-label={ariaLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        data-testid="pan-zoom-svg"
      >
        {children}
      </svg>
    </div>
  );
}
