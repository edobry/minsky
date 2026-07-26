/**
 * SessionFilmPage — the session film (mt#3184 — Watchable world Phase 1).
 *
 * Orchestrates every stage of the build: the picker (scrub-gated, spec
 * SC 1 / AT 8), the fold + keyframes (SC 3), the A0 ribbon (SC 4), the A2
 * stage (SC 5), and the scroll-as-scrub coupling — page scroll on the
 * ribbon drives the playhead, keyboard arrows step one batch row at a
 * time, the playhead is URL-addressable via `?t=` (SC 6 / AT 3), and
 * `prefers-reduced-motion` degrades the stage's tweens to discrete state
 * changes (AT 7, wired through to `SessionFilmStage`).
 *
 * Route naming is a working label per the spec ("naming is
 * principal-reserved") — registered at `/session-film` in App.tsx pending a
 * principal naming decision.
 *
 * @see session-film-fold.ts, session-film-batches.ts, session-film-layout.ts
 * @see components/session-film/* — Ribbon, Stage, Picker, Minimap
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { SessionFilmRibbon } from "../components/session-film/SessionFilmRibbon";
import { SessionFilmStage } from "../components/session-film/SessionFilmStage";
import { SessionFilmPicker } from "../components/session-film/SessionFilmPicker";
import { SessionFilmMinimap } from "../components/session-film/SessionFilmMinimap";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import {
  fetchSessionFilmEvents,
  fetchSessionFilmSessions,
  sessionFilmEventsQueryKey,
  sessionFilmRetry,
  sessionFilmSessionsQueryKey,
} from "../lib/session-film-client";
import { deriveChapters, groupEventsIntoBatchRows } from "../lib/session-film-batches";
import { buildKeyframes, foldAtBatchIndex } from "../lib/session-film-fold";
import { computeStageLayout } from "../lib/session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG, type SessionFilmConfig } from "../lib/session-film-config";

const SESSION_PARAM = "session";
const PLAYHEAD_PARAM = "t";

export interface SessionFilmPageProps {
  /**
   * Tunables override (mt#3247 R1, BLOCKING #2). Defaults to
   * `DEFAULT_SESSION_FILM_CONFIG`, but every camera/DOI/motion computation in
   * this page reads from THIS single binding — not the module constant
   * directly — and the SAME binding is threaded down to `SessionFilmStage`'s
   * `config` prop below. Before this fix the page read
   * `DEFAULT_SESSION_FILM_CONFIG` directly in three places (keyframes,
   * layout, the scroll-idle debounce) while never even passing a `config`
   * prop to the stage — a future override had no single point of injection
   * and the page's own tunables (scrollIdleMs) couldn't be overridden at all.
   */
  config?: SessionFilmConfig;
}

/** Clamp a parsed `?t=` value into `[0, rowCount-1]`, defaulting to 0 for anything unparsable. */
function parsePlayheadParam(raw: string | null, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(rowCount - 1, Math.round(parsed)));
}

export function SessionFilmPage({ config = DEFAULT_SESSION_FILM_CONFIG }: SessionFilmPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const reducedMotion = usePrefersReducedMotion();

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    searchParams.get(SESSION_PARAM)
  );
  const [verifiedRescrubbed, setVerifiedRescrubbed] = useState(false);
  const [playheadRowIndex, setPlayheadRowIndex] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  // Working click -> visible detail affordance (mt#3231 SC 6 / AT 6): lifted
  // to the page so a future cross-widget consumer (e.g. a breadcrumb) can
  // read it too; SessionFilmStage also tracks an internal fallback so it
  // still renders a panel standalone/in tests without this prop.
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [hasAppliedDeepLinkPlayhead, setHasAppliedDeepLinkPlayhead] = useState(false);

  // Scroll-idle camera suppression (mt#3247 SC2c): the ribbon's scroll-as-
  // scrub coupling advances the playhead, which can jump the touched set
  // (and hence the stage's `growingBounds`) discontinuously frame-to-frame
  // while actively scrolling — treated like a transient user-interaction
  // pause on the camera (via `SessionFilmStage`'s `scrollSuppressed` prop),
  // distinct from the dead-zone fix (which handles per-tick force-sim
  // churn) but addressing the SAME "camera never settles" failure mode from
  // the OTHER contributing cause named in the spec. Derived from the
  // EXISTING `onScrollRowChange` callback (already fired on every native
  // scroll event by the ribbon) rather than adding a new prop/listener.
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScrollRowChange = useCallback(
    (rowIndex: number) => {
      setPlayheadRowIndex(rowIndex);
      setIsScrolling(true);
      if (scrollIdleTimeoutRef.current !== null) clearTimeout(scrollIdleTimeoutRef.current);
      // mt#3247 R1 BLOCKING #2: reads the SAME `config` binding the stage
      // receives below (not the module default directly), so a config
      // override actually changes this debounce, not just the stage's own
      // camera math.
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

  const sessionsQuery = useQuery({
    queryKey: sessionFilmSessionsQueryKey(),
    queryFn: fetchSessionFilmSessions,
    staleTime: 30_000,
  });

  const eventsQuery = useQuery({
    queryKey: sessionFilmEventsQueryKey(selectedConversationId ?? "", verifiedRescrubbed),
    queryFn: () => fetchSessionFilmEvents(selectedConversationId as string, verifiedRescrubbed),
    enabled: selectedConversationId !== null,
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
  // replay per `config.deepLinkArrival`). Applied once, as soon as the row
  // data needed to clamp it is available.
  useEffect(() => {
    if (hasAppliedDeepLinkPlayhead || batchRows.length === 0) return;
    setPlayheadRowIndex(parsePlayheadParam(searchParams.get(PLAYHEAD_PARAM), batchRows.length));
    setHasAppliedDeepLinkPlayhead(true);
    // Intentionally excludes `searchParams` — this must run once per session
    // load, not on every searchParams identity change (which includes the
    // writes the OTHER effect below makes to reflect the playhead back into
    // the URL, which would otherwise re-trigger this one).
  }, [batchRows.length, hasAppliedDeepLinkPlayhead]);

  // Reflect the current playhead + session back into the URL — extends the
  // receipts discipline from entities to MOMENTS (spec: "link me to where it
  // went wrong").
  useEffect(() => {
    if (!selectedConversationId || !hasAppliedDeepLinkPlayhead) return;
    setSearchParams(
      (prev) => {
        // Functional form: `prev` is ALWAYS the LIVE URLSearchParams at the
        // moment this update actually applies, never a value captured from
        // whichever render scheduled this effect. Reviewer finding (PR #2269
        // round 1): reading the render-scope `searchParams` variable here
        // risked comparing against — and silently overwriting — a URL change
        // that happened for a reason OUTSIDE this effect (e.g. the user
        // pressing browser back/forward) between that render and this effect
        // actually running.
        if (
          prev.get(SESSION_PARAM) === selectedConversationId &&
          prev.get(PLAYHEAD_PARAM) === String(playheadRowIndex)
        ) {
          return prev; // no-op — avoid a redundant history write
        }
        const next = new URLSearchParams(prev);
        next.set(SESSION_PARAM, selectedConversationId);
        next.set(PLAYHEAD_PARAM, String(playheadRowIndex));
        return next;
      },
      { replace: true }
    );
    // Intentionally excludes `searchParams`/`setSearchParams` — this effect
    // writes to searchParams itself; the functional form above reads FRESH
    // state at apply-time instead of a closed-over value, which is what
    // makes omitting it safe (no feedback loop, no staleness).
  }, [playheadRowIndex, selectedConversationId, hasAppliedDeepLinkPlayhead]);

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
  useEffect(() => {
    if (!selectedConversationId) return;
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
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
  }, [batchRows.length, selectedConversationId]);

  const handleSelectSession = useCallback((conversationId: string) => {
    setSelectedConversationId(conversationId);
    setVerifiedRescrubbed(false);
    setPlayheadRowIndex(0);
    setSelectedRowIndex(null);
    setSelectedEntityId(null);
    setHasAppliedDeepLinkPlayhead(false);
  }, []);

  if (!selectedConversationId) {
    return (
      <div className="p-4">
        <h1 className="mb-1 text-lg font-semibold">Session film</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick an ingested session to replay as a scrollable film.
        </p>
        <SessionFilmPicker
          sessions={sessionsQuery.data ?? []}
          isLoading={sessionsQuery.isLoading}
          onSelect={handleSelectSession}
        />
      </div>
    );
  }

  if (eventsQuery.isLoading) {
    return <LoadingState variant="page" message="Loading session film…" />;
  }

  if (eventsQuery.isError) {
    return (
      <div className="p-4">
        <ErrorState error={eventsQuery.error} prefix="Failed to load session film" variant="page" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col" data-testid="session-film-page">
      <div className="flex min-h-0 flex-1">
        {/*
          Stage-first layout rebalance (mt#3226 SC 1). Operator finding:
          "why does the split exist at all" — a fixed 50/50 split gave the
          stage (the affect-bearing surface) the SAME width as the ribbon
          (a text receipts log), which is backwards for a film whose whole
          point is "watch the world move." Design note: the ribbon becomes
          a fixed-WIDTH narrow rail (not a proportion of viewport width) so
          the stage always dominates regardless of window size, while
          staying the scroll-as-scrub driver, keyboard-stepping target, and
          `?t=` receipts surface — none of that coupling lives in the
          ribbon's WIDTH, so narrowing it changes nothing structural, only
          how much of the screen prose gets vs. how much the stage gets.
        */}
        <SessionFilmRibbon
          events={events}
          batchRows={batchRows}
          chapters={chapters}
          playheadRowIndex={playheadRowIndex}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={setSelectedRowIndex}
          onScrollRowChange={handleScrollRowChange}
          className="w-80 shrink-0 border-r border-border"
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
