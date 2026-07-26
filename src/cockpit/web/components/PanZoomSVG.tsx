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
 *
 * Camera dead-zone (mt#3247 hotfix): the growing-bounds camera-follow effect
 * (mt#3231 SC 5) held a v1.2 regression where it eased toward a new fit on
 * EVERY bounds change — fine for occasional growth, but the live d3-force
 * sim (mt#3231 SC 4) and scroll-driven touched-set changes move `bounds`
 * almost every frame, so the camera perpetually chased a moving target and
 * never settled (continuous jump/flicker). The fix: the camera now holds
 * still while bounds stays within the last committed fit's viewBox plus a
 * margin (`GrowingBoundsOptions.deadZoneMarginPx`), only re-fitting when
 * content would clip past it — see the growing-bounds effect below.
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
 *
 * Camera dead-zone (mt#3247 hotfix): `deadZoneMarginPx` and `suppressed` are
 * what keep this from chasing a perpetually-moving target — see the
 * growing-bounds effect's module doc below for the mechanism.
 */
interface GrowingBoundsOptions {
  /** World-space bounding box of the content to keep framed, or `null` when there's nothing to fit yet (no-op). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** World-space padding added around `bounds` before fitting. */
  padding: number;
  /** Ease duration toward a new fit, ms. `0` snaps instantly instead of tweening — the reduced-motion degrade (matches every other motion class in this codebase: discrete state change, not a zeroed-duration tween). */
  easeMs: number;
  /**
   * Camera dead-zone margin (mt#3247 SC1), world-space units. The camera
   * holds its current fit while `bounds` stays within that fit's viewBox
   * expanded by this margin on every side; it only eases to a NEW fit when
   * `bounds` would clip past the margin — the standard game-camera "dead
   * zone" / "camera box" pattern. Defaults to `0` (no dead zone — every
   * bounds change refits, the pre-hotfix behavior) so existing callers that
   * don't pass it compile and behave unchanged.
   */
  deadZoneMarginPx?: number;
  /**
   * When `true`, auto-fit is suppressed entirely — e.g. active scroll
   * (mt#3247 SC2c), treated like a user interaction that pauses the camera
   * but WITHOUT the permanence of `userInteractedRef` (a user pan/zoom
   * overrides camera-follow for good; this is transient and self-clears
   * once the caller flips it back to `false`, at which point the next tick
   * re-evaluates the dead zone and eases to a settled fit if warranted).
   */
  suppressed?: boolean;
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

/**
 * Camera dead-zone containment check (mt#3247 hotfix, SC1): true when
 * `bounds` fits entirely inside `box` expanded outward by `marginPx` on
 * every side. `box` is the last COMMITTED fit's viewBox (converted to
 * min/max form) — the camera's current rest position, or the end target of
 * an in-flight ease — not the live (possibly mid-tween) viewBox, so the
 * check stays stable while an ease is in progress instead of comparing
 * against a moving reference.
 */
function withinDeadZone(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  box: { minX: number; minY: number; maxX: number; maxY: number },
  marginPx: number
): boolean {
  return (
    bounds.minX >= box.minX - marginPx &&
    bounds.maxX <= box.maxX + marginPx &&
    bounds.minY >= box.minY - marginPx &&
    bounds.maxY <= box.maxY + marginPx
  );
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

  /**
   * Second contributing cause of the mt#3247 jank, found during LIVE repro
   * (not in the spec's original diagnosis): the ambient-drift effect below
   * recomputed its wobble base as the FULL-BOARD `fitViewBox` every 200ms
   * tick, completely ignoring an active `growingBounds` camera-follow fit —
   * so whenever both were enabled (the session-film's normal case), the two
   * effects fought over `viewBox` on independent timers: camera-follow
   * eased toward the tight bounds fit, ambient drift snapped back toward
   * the full-board fit every 200ms, producing the exact "keeps jumping back
   * and forth" symptom even with the dead-zone fix in place. Fix: ambient
   * drift wobbles around the LATEST growing-bounds target when one exists
   * (set by that effect below), falling back to the full-board fit only
   * when camera-follow isn't active — matching the module doc's ORIGINAL
   * intent ("the camera breathes AROUND the fitted center").
   */
  const growingBoundsTargetRef = useRef<ViewBox | null>(null);
  /** Is camera-follow active at all (the prop was supplied), regardless of whether a fit has been committed yet. Read by the resize-observer effect below to avoid fighting camera-follow the same way ambient-drift did. */
  const hasGrowingBounds = growingBounds !== undefined;

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
      if (hasGrowingBounds) {
        // Camera-follow OWNS the framing (mt#3247): a resize must NOT snap
        // to the full-board fit here — that fought camera-follow on every
        // resize/reflow the exact same way the ambient-drift effect fought
        // it before the `growingBoundsTargetRef` fix above, producing a
        // visible flash back to the full board. Just correct the aspect (the
        // SAME treatment the user-interacted branch below already uses);
        // the growing-bounds effect's own next tick re-reads the container
        // size and re-fits at the new dimensions on its own cadence.
        setViewBox((vb) => ({ ...vb, h: vb.w * (height / width) }));
      } else if (!userInteractedRef.current) {
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
  }, [applyFit, hasGrowingBounds]);

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
      // Wobble around the ACTIVE camera-follow fit when one exists (mt#3247
      // — see `growingBoundsTargetRef`'s doc above), not always the
      // full-board fit — otherwise this tick fights the growing-bounds
      // effect over `viewBox` every 200ms.
      const fit = growingBoundsTargetRef.current ?? fitViewBox(boardWidth, boardHeight, width, height);
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
  // CAMERA DEAD-ZONE (mt#3247 hotfix — v1.2 REGRESSION FIX): v1.1/v1.2 keyed
  // this effect's re-run on a rounded proxy of `bounds` (`boundsKey`) — every
  // GENUINE (>=1 world-unit) change tore the effect down and restarted the
  // ease from scratch. That was fine for occasional growth, but the live
  // d3-force sim moves nodes every tick AND scroll changes the touched set
  // every frame, so `bounds` changes almost every frame in the real film —
  // the ease kept restarting toward a perpetually-moving target and never
  // converged: continuous jump/flicker, operator-blocking.
  //
  // The fix decouples "how often bounds changes" from "how often we decide
  // to re-fit": `bounds`/`suppressed` are read via REFS (synced by the two
  // small effects below, which fire on every change but never touch a
  // timer), so THIS effect mounts once per `padding`/`easeMs`/
  // `deadZoneMarginPx` (static config values) and runs its own continuous
  // poll loop. Each poll checks `withinDeadZone` against the last COMMITTED
  // fit — bounds jiggling inside that margin is a no-op (the actual dead
  // zone); only a bounds change that would clip past the margin commits a
  // NEW target and starts a fresh ease from the CURRENT live viewBox. This
  // is what "the camera holds still while content stays within the frame
  // plus a margin, and only eases when content would actually clip the
  // edge" (spec SC1) means operationally.
  //
  // Zero-size backoff (mt#3231 review R1, BLOCKING; preserved): while the
  // container reports 0x0 (hidden tab, not yet laid out) we do NOT compute a
  // fit against 0x0 — retry at a slower cadence instead of busy-polling.
  // The poll ALSO slows down (`AT_REST_POLL_MS`) whenever no ease is in
  // flight and the dead zone holds — no need to check at tween-cadence when
  // nothing is happening.
  // -------------------------------------------------------------------------
  const boundsRef = useRef(growingBounds?.bounds ?? null);
  useEffect(() => {
    boundsRef.current = growingBounds?.bounds ?? null;
  }, [growingBounds?.bounds]);

  const suppressedRef = useRef(growingBounds?.suppressed ?? false);
  useEffect(() => {
    suppressedRef.current = growingBounds?.suppressed ?? false;
  }, [growingBounds?.suppressed]);

  const growingPadding = growingBounds?.padding;
  const growingEaseMs = growingBounds?.easeMs;
  const growingDeadZoneMarginPx = growingBounds?.deadZoneMarginPx;

  useEffect(() => {
    if (!hasGrowingBounds) return;
    const padding = growingPadding ?? 0;
    const easeMs = growingEaseMs ?? 0;
    const marginPx = growingDeadZoneMarginPx ?? 0;
    const el = containerRef.current;
    if (!el) return;

    const ZERO_SIZE_RETRY_MS = 250;
    const NO_BOUNDS_RETRY_MS = 250;
    const SUPPRESSED_RETRY_MS = 150;
    const TWEEN_TICK_MS = 50;
    const AT_REST_POLL_MS = 150;

    /** The last fit committed to: the camera's rest position, or the end target of an in-flight ease. `null` until the first real fit. */
    let committedTarget: ViewBox | null = null;
    /** Non-null while an ease is in flight — the viewBox it started from. */
    let easeStart: ViewBox | null = null;
    let easeStartTime = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleTick = (delayMs: number) => {
      timeoutId = setTimeout(runTick, delayMs);
    };

    function runTick() {
      if (cancelled) return;
      if (userInteractedRef.current) return; // stopped for good — see module doc's resize-policy note
      if (suppressedRef.current) {
        // Transient pause (e.g. active scroll, mt#3247 SC2c) — re-check
        // shortly; don't advance any in-flight ease while suppressed.
        scheduleTick(SUPPRESSED_RETRY_MS);
        return;
      }
      const bounds = boundsRef.current;
      if (!bounds) {
        scheduleTick(NO_BOUNDS_RETRY_MS);
        return;
      }
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

      const needsFit =
        committedTarget === null ||
        !withinDeadZone(
          bounds,
          {
            minX: committedTarget.x,
            minY: committedTarget.y,
            maxX: committedTarget.x + committedTarget.w,
            maxY: committedTarget.y + committedTarget.h,
          },
          marginPx
        );

      if (needsFit) {
        committedTarget = fitToBoundsViewBox(bounds, padding, width, height);
        growingBoundsTargetRef.current = committedTarget; // ambient drift wobbles around THIS, not the full-board fit
        easeStart = viewBoxRef.current;
        easeStartTime = Date.now();
      }

      if (easeStart !== null) {
        const target = committedTarget!;
        if (easeMs <= 0) {
          setViewBox(target);
          easeStart = null; // snapped — converged
        } else {
          const t = Math.min(1, (Date.now() - easeStartTime) / easeMs);
          const eased = easeOutCubic(t);
          setViewBox({
            x: easeStart.x + (target.x - easeStart.x) * eased,
            y: easeStart.y + (target.y - easeStart.y) * eased,
            w: easeStart.w + (target.w - easeStart.w) * eased,
            h: easeStart.h + (target.h - easeStart.h) * eased,
          });
          if (t >= 1) easeStart = null; // converged — hold at rest until the dead zone is exceeded again
        }
      }

      // Poll faster while actively easing (smooth tween); back off once at
      // rest and the dead zone holds — nothing to do until bounds moves.
      scheduleTick(easeStart !== null ? TWEEN_TICK_MS : AT_REST_POLL_MS);
    }

    scheduleTick(0);
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      growingBoundsTargetRef.current = null; // camera-follow torn down — ambient drift (if any) falls back to the full-board fit
    };
  }, [hasGrowingBounds, growingPadding, growingEaseMs, growingDeadZoneMarginPx]);

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
