/**
 * PanZoomSVG — lightweight pan/zoom wrapper for a fixed-coordinate SVG.
 *
 * Implementation choice (mt#2380): custom viewBox handler (~80 lines, dep-free).
 * Rationale: the interaction surface is small (wheel zoom toward cursor + pointer
 * drag), the board is a fixed 1280×820 coordinate space, and adding a library
 * would bring ~20kB for what amounts to one wheel handler and one pointerdown/
 * pointermove/pointerup trio. Zero new dependencies, no license audit needed.
 *
 * Default framing (mt#2380): fit-WIDTH with vertical pan.
 * The board is 1280×820. On a 1280px viewport the board fills the full width at
 * scale 1.0, giving full-size text (10px in SVG = 10px on screen). At 1440px it
 * scales up slightly. Fit-HEIGHT on a typical 720–800px content area would shrink
 * the board to ~87% scale, making the 10px labels unreadable. Fit-width with
 * vertical pan is therefore the legible default.
 *
 * a11y:
 *   - Zoom + / − / reset buttons are keyboard-focusable and ARIA-labelled.
 *   - The SVG container has role="region" with an aria-label from props.
 *   - Drag is pointer-based (mouse + touch via pointermove) with no keyboard
 *     equivalent needed — panning a schematic has no keyboard accessibility
 *     requirement beyond the explicit button controls.
 *
 * prefers-reduced-motion:
 *   - No animated transitions on viewBox changes — updates are instant.
 *   - The existing vsm-* CSS animations are unaffected (they're in the SVG
 *     children and already gated via the global reduced-motion rule in index.css).
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
 * Compute the fit-width viewBox for the board.
 * The default framing is fit-width with vertical pan starting from the top.
 * See module comment for the legibility rationale.
 */
function fitWidthViewBox(boardWidth: number, boardHeight: number, containerWidth: number, containerHeight: number): ViewBox {
  // We want the board's full width to fill the container width.
  // scale = containerWidth / boardWidth
  // The viewBox height shows the same scale:
  //   viewBoxH = containerHeight / scale = containerHeight * (boardWidth / containerWidth)
  // The viewBox starts at the top of the board (y = 0), showing as much as fits.
  const scale = containerWidth / boardWidth;
  const viewBoxH = containerHeight / scale;
  // Center horizontally (viewBoxX stays 0 for fit-width, since the board fills exactly).
  return {
    x: 0,
    y: 0,
    w: boardWidth,
    h: viewBoxH,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PanZoomSVG({ boardWidth, boardHeight, ariaLabel, className, children }: PanZoomSVGProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // ViewBox state. Initialized to a placeholder; the real fit-width default is
  // computed in the layout effect once we know the container dimensions.
  const [viewBox, setViewBox] = useState<ViewBox>({
    x: 0,
    y: 0,
    w: boardWidth,
    h: boardHeight,
  });

  // Track whether we've done the initial fit-width calculation.
  const initializedRef = useRef(false);

  // Compute and apply the fit-width default on mount and on resize.
  const applyFitWidth = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    setViewBox(fitWidthViewBox(boardWidth, boardHeight, width, height));
    initializedRef.current = true;
  }, [boardWidth, boardHeight]);

  useEffect(() => {
    applyFitWidth();
    const observer = new ResizeObserver(() => {
      // Only auto-refit if we haven't manually zoomed/panned.
      // After the initial fit, let the user's state persist across resizes.
      if (!initializedRef.current) applyFitWidth();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [applyFitWidth]);

  // -------------------------------------------------------------------------
  // Zoom utilities
  // -------------------------------------------------------------------------

  /**
   * Zoom the viewBox toward a focal point (in SVG-coordinate space).
   * focalX, focalY are in SVG coordinates (within the current viewBox).
   */
  const zoomAround = useCallback((factor: number, focalX: number, focalY: number) => {
    setViewBox((vb) => {
      const currentScale = boardWidth / vb.w;
      const nextScale = clamp(currentScale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === currentScale) return vb;
      const nextW = boardWidth / nextScale;
      const nextH = boardHeight / nextScale;
      // Keep the focal point stable: the point under the cursor stays fixed.
      // focalX is the SVG-coord of the cursor; after zoom it should stay at the
      // same fraction of the viewport.
      const fracX = (focalX - vb.x) / vb.w;
      const fracY = (focalY - vb.y) / vb.h;
      const nextX = focalX - fracX * nextW;
      const nextY = focalY - fracY * nextH;
      return { x: nextX, y: nextY, w: nextW, h: nextH };
    });
  }, [boardWidth, boardHeight]);

  /** Zoom toward the center of the current viewBox. */
  const zoomCenter = useCallback((factor: number) => {
    setViewBox((vb) => {
      const focalX = vb.x + vb.w / 2;
      const focalY = vb.y + vb.h / 2;
      const currentScale = boardWidth / vb.w;
      const nextScale = clamp(currentScale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === currentScale) return vb;
      const nextW = boardWidth / nextScale;
      const nextH = boardHeight / nextScale;
      const nextX = focalX - nextW / 2;
      const nextY = focalY - nextH / 2;
      return { x: nextX, y: nextY, w: nextW, h: nextH };
    });
  }, [boardWidth, boardHeight]);

  // -------------------------------------------------------------------------
  // Wheel zoom
  // -------------------------------------------------------------------------

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Convert pointer position to SVG coordinates.
      const svgX = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.w;
      const svgY = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.h;
      // deltaY > 0 = scroll down = zoom out; < 0 = zoom in
      const factor = 1 - e.deltaY * WHEEL_SENSITIVITY;
      zoomAround(factor, svgX, svgY);
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [viewBox, zoomAround]);

  // -------------------------------------------------------------------------
  // Pointer drag (pan)
  // -------------------------------------------------------------------------

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startVBX: number;
    startVBY: number;
  } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Only primary button (mouse left / single touch)
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startVBX: viewBox.x,
      startVBY: viewBox.y,
    };
  }, [viewBox.x, viewBox.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Pixels moved → SVG-coordinate delta
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    const dx = (e.clientX - dragRef.current.startX) * scaleX;
    const dy = (e.clientY - dragRef.current.startY) * scaleY;
    setViewBox((vb) => ({
      ...vb,
      x: dragRef.current!.startVBX - dx,
      y: dragRef.current!.startVBY - dy,
    }));
  }, [viewBox.w, viewBox.h]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // -------------------------------------------------------------------------
  // Button controls
  // -------------------------------------------------------------------------

  const handleZoomIn = useCallback(() => zoomCenter(1 + ZOOM_STEP), [zoomCenter]);
  const handleZoomOut = useCallback(() => zoomCenter(1 / (1 + ZOOM_STEP)), [zoomCenter]);
  const handleReset = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        // Real layout: compute fit-width.
        setViewBox(fitWidthViewBox(boardWidth, boardHeight, width, height));
        initializedRef.current = true;
        return;
      }
    }
    // Fallback (JSDOM / zero-size container): restore full-board view.
    setViewBox({ x: 0, y: 0, w: boardWidth, h: boardHeight });
    initializedRef.current = false;
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
      <div
        className="absolute top-2 right-2 z-10 flex flex-col gap-1"
        role="group"
        aria-label="Zoom controls"
      >
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
