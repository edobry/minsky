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
  SessionFilmError,
  fetchSessionFilmEvents,
  sessionFilmEventsQueryKey,
  sessionFilmRetry,
} from "../../lib/session-film-client";
import {
  deriveChapters,
  findRowForTurnAddress,
  groupEventsIntoBatchRows,
} from "../../lib/session-film-batches";
import {
  TOOL_USE_PARAM,
  TURN_PARAM,
  parseTurnAddress,
  type TurnAddress,
} from "../../lib/conversation-turn-address";
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

/**
 * The ribbon's DOM id, so the divider can name what it sizes in `aria-controls`
 * (mt#4261). A constant rather than a literal at each site because the two uses
 * — the element's `id` and the divider's `controls` — are only correct together.
 */
const RIBBON_DOM_ID = "session-film-ribbon";

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

/**
 * The lead-in the film's error state renders, chosen by WHAT failed (mt#4135).
 *
 * Only `session_not_found` may assert the film is absent. The events route
 * answers 404 for two different reasons — that one, and `invalid_id` when the
 * requested id is not one this cockpit can film — so branching on HTTP status
 * would tell a reader who followed a bad id that their conversation has no
 * film. That is the same misreport mt#3225 fixed on the server side, where a
 * too-narrow `looksLikeConversationId` rejected 45 real subagent transcripts;
 * an operator debugging it here would have been told the transcript did not
 * exist. Everything else — a 500, the 15s assembly timeout, or a network
 * failure that never produces a `SessionFilmError` at all — reports a failed
 * read, which is what distinguishes "there is nothing here" from "try again".
 *
 * This branch no longer covers a scrub-gate refusal: mt#3268 / ADR-040 removed
 * the gate from this endpoint, on the decision that it binds where transcript
 * bytes cross the trust boundary (export, anonymous share link) rather than on
 * the operator's own authenticated read.
 *
 * A reader who ARRIVED FROM A LINK asked for one specific moment, so a bare
 * cause answers a question they did not ask and leaves the click looking broken
 * (mt#3794, reviewer round 1). Naming the moment they wanted is the difference
 * between a dead end and an explained one — and this is the only place that can
 * say it, since the conversation view has no per-conversation film-availability
 * signal to gate the link on.
 *
 * `ErrorState` appends the error's own message after this lead-in, so the
 * server's detail is not lost either way; what this chooses is the sentence the
 * reader takes as the answer.
 */
export function filmErrorLeadIn(error: unknown, arrivedByAddress: boolean): string {
  const code = error instanceof SessionFilmError ? error.code : undefined;
  const cause =
    code === "session_not_found"
      ? "this conversation has no film"
      : code === "invalid_id"
        ? "that id is not a conversation this cockpit can film"
        : "the film could not be loaded";
  return arrivedByAddress
    ? `That moment can't be shown — ${cause}`
    : `${cause.charAt(0).toUpperCase()}${cause.slice(1)}`;
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
  /** An address the URL carried that matched no event in this film (mt#3794). */
  const [unresolvedAddress, setUnresolvedAddress] = useState<TurnAddress | null>(null);

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
    setUnresolvedAddress(null);
  }, [conversationId]);

  const eventsQuery = useQuery({
    queryKey: sessionFilmEventsQueryKey(conversationId),
    queryFn: () => fetchSessionFilmEvents(conversationId),
    retry: sessionFilmRetry,
  });

  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const batchRows = useMemo(() => groupEventsIntoBatchRows(events), [events]);
  const chapters = useMemo(() => deriveChapters(events, batchRows), [events, batchRows]);
  const keyframes = useMemo(
    () => buildKeyframes(events, batchRows, config),
    [events, batchRows, config]
  );

  // Deep-link arrival (spec: default "snap" — instant, no catch-up replay per
  // `config.deepLinkArrival`). Applied once, as soon as the row data needed to
  // resolve it is available.
  //
  // TWO address forms, and the turn address wins. `?t=` is an ORDINAL — an
  // index into this film's batch rows, which only this component can compute —
  // so it is what the film writes back as receipts, and it stays exactly as it
  // was. `?turn=`/`?toolUse=` is an IDENTITY (mt#3794), which is what a link
  // from OUTSIDE the film can actually carry: the conversation view knows which
  // transcript line a row came from, and knows nothing about batch grouping.
  // When both are present the identity is the one a reader asked for.
  useEffect(() => {
    if (hasAppliedDeepLinkPlayhead || batchRows.length === 0) return;
    const address = parseTurnAddress(searchParams);
    if (address) {
      const rowIndex = findRowForTurnAddress(events, batchRows, address);
      if (rowIndex === null) {
        // Land at the film's start and SAY SO. Silently landing at row 0 would
        // be indistinguishable from a film that simply opens there, so the
        // reader would believe they were shown the moment they clicked.
        setUnresolvedAddress(address);
      } else {
        setPlayheadRowIndex(rowIndex);
        // Marks the row as well as moving to it: the ribbon's playhead follows
        // scroll continuously, so the playhead alone does not say "this is the
        // one you came for" once the reader nudges the wheel.
        setSelectedRowIndex(rowIndex);
      }
    } else {
      setPlayheadRowIndex(parsePlayheadParam(searchParams.get(PLAYHEAD_PARAM), batchRows.length));
    }
    setHasAppliedDeepLinkPlayhead(true);
    // Intentionally excludes `searchParams` — this must run once per film load,
    // not on every searchParams identity change (which includes the writes the
    // effect below makes, which would otherwise re-trigger this one). `events`
    // is excluded for the same reason and is safe to omit: it and `batchRows`
    // are derived from the same query result, so `batchRows.length` becoming
    // non-zero is exactly when both are available.
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
        const carriesAddress = prev.has(TURN_PARAM) || prev.has(TOOL_USE_PARAM);
        if (prev.get(PLAYHEAD_PARAM) === String(playheadRowIndex) && !carriesAddress) {
          return prev; // no-op — avoid a redundant history write
        }
        const next = new URLSearchParams(prev);
        next.set(PLAYHEAD_PARAM, String(playheadRowIndex));
        // CONSUME the turn address rather than leaving it beside `t` (mt#3794).
        // `t` is rewritten on every scrub; the address is read once at load and
        // wins over `t` when present. Leaving both means a URL copied after
        // scrubbing carries a stale address that beats the ordinal the reader
        // was actually looking at — they would share "here" and the recipient
        // would land somewhere else. Consuming it keeps the URL a true
        // statement about where the playhead is.
        next.delete(TURN_PARAM);
        next.delete(TOOL_USE_PARAM);
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
    const arrivedByAddress = parseTurnAddress(searchParams) !== null;
    return (
      <div className="p-4">
        <ErrorState
          error={eventsQuery.error}
          prefix={filmErrorLeadIn(eventsQuery.error, arrivedByAddress)}
          variant="page"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-film">
      {unresolvedAddress && (
        /*
          The reader arrived from a link that named a moment this film does not
          have — a turn whose actions produced no event (a verb the adapter does
          not emit), or an address stale after a re-ingest reordered the
          transcript. Not an error state: the film is fine and fully usable, the
          landing is just the start rather than the moment asked for, which is
          the one thing the reader cannot infer from what they see.
        */
        <div
          className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="session-film-unresolved-address"
        >
          Couldn&apos;t find that moment — nothing in this film came from turn{" "}
          {unresolvedAddress.turnIndex}. Showing the start.
        </div>
      )}
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
          id={RIBBON_DOM_ID}
          style={{ width: ribbonWidthPx }}
        />
        <PaneDivider
          value={ribbonWidthPx}
          min={MIN_RIBBON_WIDTH_PX}
          max={ribbonMaxPx}
          controls={RIBBON_DOM_ID}
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
          // The detail panel's inspector inputs (mt#3793). `events` and
          // `batchRows` let it show an entity's action HISTORY rather than only
          // the fold's latest verb; `onSeekToRow` is what makes a history line
          // clickable — the playhead is THIS component's state, so the stage can
          // only name a destination row and ask for the move. Reusing
          // `setPlayheadRowIndex` (not a bespoke handler) means a seek from the
          // panel is the same operation as a keyboard step or a minimap jump,
          // including the `?t=` write that follows it.
          events={events}
          batchRows={batchRows}
          playheadRowIndex={playheadRowIndex}
          onSeekToRow={setPlayheadRowIndex}
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
