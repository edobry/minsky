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

interface PanZoomSVGProps {
  /** Intrinsic coordinate width of the SVG drawing area. */
  boardWidth: number;
  /** Intrinsic coordinate height of the SVG drawing area. */
  boardHeight: number;
  /** Accessible label for the SVG region. */
  ariaLabel: string;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PanZoomSVG({ boardWidth, boardHeight, ariaLabel, className, children }: PanZoomSVGProps) {
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
