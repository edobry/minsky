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
import { useCallback, useEffect, useMemo, useState } from "react";
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
  SessionFilmError,
  fetchSessionFilmEvents,
  fetchSessionFilmSessions,
  sessionFilmEventsQueryKey,
  sessionFilmRetry,
  sessionFilmSessionsQueryKey,
} from "../lib/session-film-client";
import { deriveChapters, groupEventsIntoBatchRows } from "../lib/session-film-batches";
import { buildKeyframes, foldAtBatchIndex } from "../lib/session-film-fold";
import { computeStageLayout } from "../lib/session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG } from "../lib/session-film-config";

const SESSION_PARAM = "session";
const PLAYHEAD_PARAM = "t";

/** Clamp a parsed `?t=` value into `[0, rowCount-1]`, defaulting to 0 for anything unparsable. */
function parsePlayheadParam(raw: string | null, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(rowCount - 1, Math.round(parsed)));
}

export function SessionFilmPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const reducedMotion = usePrefersReducedMotion();

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    searchParams.get(SESSION_PARAM)
  );
  const [verifiedRescrubbed, setVerifiedRescrubbed] = useState(false);
  const [playheadRowIndex, setPlayheadRowIndex] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [hasAppliedDeepLinkPlayhead, setHasAppliedDeepLinkPlayhead] = useState(false);

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
    () => buildKeyframes(events, batchRows, DEFAULT_SESSION_FILM_CONFIG),
    [events, batchRows]
  );

  // `?t=` deep-link arrival (spec: default "snap" — instant, no catch-up
  // replay per DEFAULT_SESSION_FILM_CONFIG.deepLinkArrival). Applied once,
  // as soon as the row data needed to clamp it is available.
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
    const next = new URLSearchParams(searchParams);
    next.set(SESSION_PARAM, selectedConversationId);
    next.set(PLAYHEAD_PARAM, String(playheadRowIndex));
    // Avoid a redundant history write when nothing actually changed.
    if (next.get(SESSION_PARAM) === searchParams.get(SESSION_PARAM) && next.get(PLAYHEAD_PARAM) === searchParams.get(PLAYHEAD_PARAM)) {
      return;
    }
    setSearchParams(next, { replace: true });
    // Intentionally excludes `searchParams`/`setSearchParams` — this effect
    // writes to searchParams itself; including it would create a feedback loop.
  }, [playheadRowIndex, selectedConversationId, hasAppliedDeepLinkPlayhead]);

  const worldState = useMemo(
    () => foldAtBatchIndex(events, batchRows, keyframes, playheadRowIndex),
    [events, batchRows, keyframes, playheadRowIndex]
  );

  const nowIso =
    batchRows[playheadRowIndex]?.tStart ?? events[0]?.tStart ?? new Date(0).toISOString();
  const layout = useMemo(
    () => computeStageLayout(worldState, nowIso, DEFAULT_SESSION_FILM_CONFIG),
    [worldState, nowIso]
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
        <SessionFilmRibbon
          events={events}
          batchRows={batchRows}
          chapters={chapters}
          playheadRowIndex={playheadRowIndex}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={setSelectedRowIndex}
          onScrollRowChange={setPlayheadRowIndex}
          className="w-1/2 border-r border-border"
        />
        <SessionFilmStage
          layout={layout}
          world={worldState}
          reducedMotion={reducedMotion}
          className="w-1/2"
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
