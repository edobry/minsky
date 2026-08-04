/**
 * SessionFilm — the film body for ONE conversation (mt#3461).
 *
 * Extracted from the former `SessionFilmPage` when the film was folded into
 * `/conversation/:id` as a Film tab (mt#3461). That page owned two things:
 * picking a conversation, and rendering that conversation's film. Only the
 * second is still needed — the conversation comes from the route now, so the
 * picker and its `?session=` param are gone, and the page itself was deleted
 * along with the `/session-film` route (mt#3468).
 *
 * `/conversation/:id/film` is the ONLY path to a film. It is deliberately not
 * offered on `/agents/:id` — a film replays a conversation, and reaching one
 * through a workspace would mean "the film of whichever conversation is
 * currently selected," which names no specific thing (mt#3468).
 *
 * What deliberately did NOT change: the fold, the keyframes, the camera, the
 * scroll-as-scrub coupling, and the `?t=` playhead addressing are the same code
 * that ran on the standalone page. This is a re-hosting, not a rewrite —
 * mt#3226/mt#3231/mt#3247/mt#3258 tuned this surface across four rounds and none
 * of that is in scope here.
 *
 * @see components/session-film/* — Ribbon, Stage, Minimap
 * @see lib/session-film-fold.ts, session-film-batches.ts, session-film-layout.ts
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "../LoadingState";
import { ErrorState } from "../ErrorState";
import { SessionFilmRibbon } from "./SessionFilmRibbon";
import { SessionFilmStage } from "./SessionFilmStage";
import { SessionFilmMinimap } from "./SessionFilmMinimap";
import { PaneDivider } from "../PaneDivider";
import {
  clampPaneWidth,
  loadPaneWidth,
  paneWidthCeiling,
  savePaneWidth,
} from "../../lib/pane-width";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { isTextEntryTarget } from "../../lib/keyboard";
import {
  fetchSessionFilmEvents,
  sessionFilmEventsQueryKey,
  sessionFilmRetry,
} from "../../lib/session-film-client";
import { deriveChapters, groupEventsIntoBatchRows } from "../../lib/session-film-batches";
import { buildKeyframes, foldAtBatchIndex } from "../../lib/session-film-fold";
import { computeStageLayout } from "../../lib/session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG, type SessionFilmConfig } from "../../lib/session-film-config";

export const PLAYHEAD_PARAM = "t";

/**
 * Ribbon width (mt#3701). The DEFAULT is unchanged — 256px is what `w-64` was,
 * and mt#3226 SC 1 / mt#3258 SC 4 chose it as the smallest width that still
 * fits the glyphic row's icon badge, realm swatch, and a readable truncated
 * target label. What changed is that the operator can now move it: the rail
 * carries variable-length labels and the stage's useful area varies with the
 * fold, so the right balance is per-film and per-window, not a constant.
 *
 * `MIN` is below the default on purpose. It is the point at which a row still
 * shows its badge and a few characters of label — cramped, but the operator
 * asking for cramped is asking to see more stage, which is a legitimate thing
 * to want. `MAX_FRACTION` is the real protection: it keeps the stage from being
 * squeezed to nothing in a narrow window regardless of what was stored.
 */
export const DEFAULT_RIBBON_WIDTH_PX = 256;
export const MIN_RIBBON_WIDTH_PX = 192;
export const MAX_RIBBON_WIDTH_PX = 640;
const MAX_RIBBON_FRACTION = 0.6;

/**
 * One preference for the film surface, not one per conversation: the operator
 * is expressing how they like to READ a film, and re-tuning that on every
 * conversation would be the opposite of a preference.
 *
 * localStorage key name, not a credential — gitleaks generic-api-key
 * false-positives on the `*KEY = "<string>"` shape (mirrors lib/tabs.tsx).
 */
const RIBBON_WIDTH_STORAGE_KEY = "cockpit.session-film.ribbon-width.v1"; // gitleaks:allow

export interface SessionFilmProps {
  /** The conversation to replay. Supplied by the route, not by a picker. */
  conversationId: string;
  /**
   * Tunables override (mt#3247 R1). Every camera/DOI/motion computation here
   * reads from THIS binding — not the module constant — and the SAME binding is
   * threaded into `SessionFilmStage`'s `config` prop, so an override actually
   * reaches both the stage's camera math and this component's scroll-idle
   * debounce.
   */
  config?: SessionFilmConfig;
}

/** Clamp a parsed `?t=` value into `[0, rowCount-1]`, defaulting to 0 for anything unparsable. */
export function parsePlayheadParam(raw: string | null, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(rowCount - 1, Math.round(parsed)));
}

export function SessionFilm({
  conversationId,
  config = DEFAULT_SESSION_FILM_CONFIG,
}: SessionFilmProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const reducedMotion = usePrefersReducedMotion();

  const [playheadRowIndex, setPlayheadRowIndex] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  // Working click -> visible detail affordance (mt#3231 SC 6 / AT 6).
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [hasAppliedDeepLinkPlayhead, setHasAppliedDeepLinkPlayhead] = useState(false);

  // Ribbon/stage split (mt#3701). Two values, deliberately: `storedRibbonWidth`
  // is the operator's PREFERENCE, bounded only by min/max; `ribbonWidthPx` is
  // what actually renders, additionally bounded by the measured container. A
  // narrow window therefore narrows the rail without overwriting a wider
  // preference the operator set at a larger size — resize the window back and
  // their width returns.
  const [splitWidthPx, setSplitWidthPx] = useState(0);
  const [storedRibbonWidth, setStoredRibbonWidth] = useState(() =>
    loadPaneWidth(RIBBON_WIDTH_STORAGE_KEY, DEFAULT_RIBBON_WIDTH_PX, {
      min: MIN_RIBBON_WIDTH_PX,
      max: MAX_RIBBON_WIDTH_PX,
    })
  );
  /**
   * A CALLBACK ref, not a `useRef` + mount effect. This component returns early
   * — a loading state, then possibly an error state — before the split exists,
   * so a `useEffect(..., [])` runs on the LOADING frame, finds `.current` null,
   * and never runs again: the observer is never attached and the width is stuck
   * at 0, which silently disables the container-fraction bound entirely. (That
   * was the shipped behavior until `scripts/verify-session-film-panes.ts`
   * measured it — happy-dom reports 0 for the container either way, so no
   * component test could distinguish "unmeasured" from "measured as 0".)
   * A callback ref instead fires exactly when the node enters and leaves the
   * tree, whichever render that happens on.
   */
  const splitObserverRef = useRef<ResizeObserver | null>(null);
  const splitRef = useCallback((node: HTMLDivElement | null) => {
    splitObserverRef.current?.disconnect();
    splitObserverRef.current = null;
    if (!node) {
      setSplitWidthPx(0);
      return;
    }
    const measure = () => setSplitWidthPx(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    splitObserverRef.current = observer;
  }, []);
  const renderBounds = {
    min: MIN_RIBBON_WIDTH_PX,
    max: MAX_RIBBON_WIDTH_PX,
    containerWidth: splitWidthPx,
    maxFraction: MAX_RIBBON_FRACTION,
  };
  const ribbonWidthPx = clampPaneWidth(storedRibbonWidth, renderBounds);
  // The REACHABLE max, not the static one: in a narrow window the fraction bound
  // holds the rail well below `MAX_RIBBON_WIDTH_PX`, and a divider announcing
  // the static value would tell a screen-reader user about a range that does not
  // exist (PR #2632 R1). `min` needs no such treatment — the ceiling never drops
  // below it, so it stays reachable at every container width.
  const ribbonMaxPx = Math.round(paneWidthCeiling(renderBounds));
  const handleRibbonResize = useCallback((nextWidthPx: number) => {
    const next = clampPaneWidth(nextWidthPx, {
      min: MIN_RIBBON_WIDTH_PX,
      max: MAX_RIBBON_WIDTH_PX,
    });
    setStoredRibbonWidth(next);
    savePaneWidth(RIBBON_WIDTH_STORAGE_KEY, next);
  }, []);
  const handleRibbonResetWidth = useCallback(() => {
    setStoredRibbonWidth(DEFAULT_RIBBON_WIDTH_PX);
    savePaneWidth(RIBBON_WIDTH_STORAGE_KEY, DEFAULT_RIBBON_WIDTH_PX);
  }, []);

  // Scroll-idle camera suppression (mt#3247 SC2c): the ribbon's scroll-as-scrub
  // coupling advances the playhead, which can jump the touched set (and hence
  // the stage's `growingBounds`) discontinuously frame-to-frame while actively
  // scrolling — treated like a transient user-interaction pause on the camera.
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScrollRowChange = useCallback(
    (rowIndex: number) => {
      setPlayheadRowIndex(rowIndex);
      setIsScrolling(true);
      if (scrollIdleTimeoutRef.current !== null) clearTimeout(scrollIdleTimeoutRef.current);
      scrollIdleTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, config.camera.scrollIdleMs);
    },
    [config]
  );
  useEffect(
    () => () => {
      if (scrollIdleTimeoutRef.current !== null) clearTimeout(scrollIdleTimeoutRef.current);
    },
    []
  );

  // Re-key every piece of playhead state when the prop names a different
  // conversation. On the standalone page `handleSelectSession` did this; here
  // the conversation arrives as a prop, so the reset keys off the prop.
  //
  // `RunDetail` also passes `key={activeConversationId}`, which remounts this
  // component outright and makes the effect redundant THERE. It stays because
  // the component must be correct on its own terms: a caller that renders
  // <SessionFilm> without a key and swaps the prop would otherwise carry the
  // previous film's playhead and selection into the new one. Correctness that
  // depends on every caller remembering a `key` is not correctness.
  useEffect(() => {
    setPlayheadRowIndex(0);
    setSelectedRowIndex(null);
    setSelectedEntityId(null);
    setHasAppliedDeepLinkPlayhead(false);
  }, [conversationId]);

  // `verifiedRescrubbed` is pinned false: nothing in the UI has ever set it
  // true (verified across the whole `web/**` tree at extraction time), and the
  // standalone page only ever RESET it. The server-side scrub gate is the real
  // enforcement — see the error branch below. Kept as an explicit constant
  // rather than dropped so the query key still matches
  // `sessionFilmEventsQueryKey`'s signature.
  const verifiedRescrubbed = false;

  const eventsQuery = useQuery({
    queryKey: sessionFilmEventsQueryKey(conversationId, verifiedRescrubbed),
    queryFn: () => fetchSessionFilmEvents(conversationId, verifiedRescrubbed),
    retry: sessionFilmRetry,
  });

  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const batchRows = useMemo(() => groupEventsIntoBatchRows(events), [events]);
  const chapters = useMemo(() => deriveChapters(events, batchRows), [events, batchRows]);
  const keyframes = useMemo(
    () => buildKeyframes(events, batchRows, config),
    [events, batchRows, config]
  );

  // `?t=` deep-link arrival (spec: default "snap" — instant, no catch-up
  // replay per `config.deepLinkArrival`). Applied once, as soon as the row data
  // needed to clamp it is available.
  useEffect(() => {
    if (hasAppliedDeepLinkPlayhead || batchRows.length === 0) return;
    setPlayheadRowIndex(parsePlayheadParam(searchParams.get(PLAYHEAD_PARAM), batchRows.length));
    setHasAppliedDeepLinkPlayhead(true);
    // Intentionally excludes `searchParams` — this must run once per film load,
    // not on every searchParams identity change (which includes the writes the
    // effect below makes, which would otherwise re-trigger this one).
  }, [batchRows.length, hasAppliedDeepLinkPlayhead]);

  // Reflect the playhead back into the URL — extends the receipts discipline
  // from entities to MOMENTS ("link me to where it went wrong"). Only `t` is
  // written now; the conversation lives in the path, not in a query param.
  useEffect(() => {
    if (!hasAppliedDeepLinkPlayhead) return;
    setSearchParams(
      (prev) => {
        // Functional form: `prev` is ALWAYS the LIVE URLSearchParams at the
        // moment this update applies, never a value captured from whichever
        // render scheduled the effect (PR #2269 R1 — reading the render-scope
        // variable risked overwriting a URL change made for a reason outside
        // this effect, e.g. browser back/forward).
        if (prev.get(PLAYHEAD_PARAM) === String(playheadRowIndex)) {
          return prev; // no-op — avoid a redundant history write
        }
        const next = new URLSearchParams(prev);
        next.set(PLAYHEAD_PARAM, String(playheadRowIndex));
        return next;
      },
      { replace: true }
    );
    // Intentionally excludes `searchParams`/`setSearchParams` — this effect
    // writes searchParams itself; the functional form reads fresh state at
    // apply-time, which is what makes omitting it safe.
  }, [playheadRowIndex, hasAppliedDeepLinkPlayhead]);

  const worldState = useMemo(
    () => foldAtBatchIndex(events, batchRows, keyframes, playheadRowIndex),
    [events, batchRows, keyframes, playheadRowIndex]
  );

  const nowIso =
    batchRows[playheadRowIndex]?.tStart ?? events[0]?.tStart ?? new Date(0).toISOString();
  const layout = useMemo(
    () => computeStageLayout(worldState, nowIso, config),
    [worldState, nowIso, config]
  );

  // Keyboard stepping — one batch row per arrow press (spec SC 6).
  //
  // Focus guard comes from `lib/keyboard.ts` (adopted while landing mt#3466):
  // that module was created to unify mt#3464's and mt#3469's duplicate copies
  // and states that a new shortcut should import it rather than write a third.
  // This handler WAS a third copy, and a narrower one — it missed `SELECT`
  // (where typeahead silently changes a value) and contenteditable hosts.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTextEntryTarget(e.target)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setPlayheadRowIndex((i) => Math.min(batchRows.length - 1, i + 1));
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setPlayheadRowIndex((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [batchRows.length]);

  if (eventsQuery.isLoading) {
    return <LoadingState variant="page" message="Loading the film…" />;
  }

  if (eventsQuery.isError) {
    // The scrub gate lives server-side (`assertScrubGate` on
    // GET /api/cockpit/session-film/events) and rejects transcripts from before
    // the credential-scrub cutover. The standalone picker used to keep those
    // conversations unreachable by disabling their row (`scrubGateOk: false`);
    // with the picker gone, a conversation is reachable from its own page
    // whether or not it passes, so THIS branch is now the only thing standing
    // between the operator and a raw failure. Keep the message legible.
    // (mt#3268 owns the open question of whether the film's refusal or the
    // conversation view's ungated render is the right posture.)
    return (
      <div className="p-4">
        <ErrorState
          error={eventsQuery.error}
          prefix="This conversation has no film"
          variant="page"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-film">
      <div ref={splitRef} className="flex min-h-0 flex-1">
        {/*
          Stage-first layout (mt#3226 SC 1, narrowed by mt#3258 SC 4, made
          adjustable by mt#3701). The ribbon is an EXPLICIT-width rail — never a
          proportion of viewport width — so the stage dominates at any window
          size while the ribbon stays the scroll-as-scrub driver,
          keyboard-stepping target, and `?t=` receipts surface. The width is now
          the operator's, defaulting to the 256px this rail always used; the
          `MAX_RIBBON_FRACTION` bound is what preserves "the stage dominates" as
          an invariant rather than a consequence of the constant.

          `shrink-0` is as load-bearing as the width itself: without it the
          flex-1 stage can squeeze the rail below whatever was dragged.
        */}
        <SessionFilmRibbon
          events={events}
          batchRows={batchRows}
          chapters={chapters}
          playheadRowIndex={playheadRowIndex}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={setSelectedRowIndex}
          onScrollRowChange={handleScrollRowChange}
          className="shrink-0"
          style={{ width: ribbonWidthPx }}
        />
        <PaneDivider
          value={ribbonWidthPx}
          min={MIN_RIBBON_WIDTH_PX}
          max={ribbonMaxPx}
          onChange={handleRibbonResize}
          onReset={handleRibbonResetWidth}
          label="Resize the event ribbon"
          data-testid="session-film-divider"
        />
        <SessionFilmStage
          layout={layout}
          world={worldState}
          reducedMotion={reducedMotion}
          nowIso={nowIso}
          onSelectEntity={setSelectedEntityId}
          selectedEntityId={selectedEntityId}
          scrollSuppressed={isScrolling}
          config={config}
          className="min-w-0 flex-1"
        />
      </div>
      <SessionFilmMinimap
        rowCount={batchRows.length}
        playheadRowIndex={playheadRowIndex}
        onJump={setPlayheadRowIndex}
      />
    </div>
  );
}
