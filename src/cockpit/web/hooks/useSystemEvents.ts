/**
 * useSystemEvents — polls the cockpit's `/api/activity` endpoint (mt#2092 /
 * mt#2340 system_events substrate) for the plant board's fast-clock motion
 * layer (mt#2377 v2.0).
 *
 * Polling, not SSE: `system_events` emits don't NOTIFY yet (producers pending
 * mt#1854), so `/api/events` SSE would stay silent for these. The poll
 * interval is the fast-clock resolution — gestures fire within one interval
 * of the real transition. mt#2481 owns the SSE upgrade once producers land.
 *
 * mt#2600 adds `useReplayEvents`: a one-shot (non-polling) fetch of a fixed
 * `since`/`until` window for the time-scrubber replay feature, sharing the
 * same row shape and endpoint as the live poller.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReplayWindow } from "../lib/plant-replay";

export interface SystemEventRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export const SYSTEM_EVENTS_POLL_MS = 8_000;

/** Max rows fetched for a replay window — generous vs. the live poll's 50,
 *  since a scrubbed window may legitimately contain a burst of history. */
const REPLAY_WINDOW_LIMIT = 500;

async function fetchActivity(): Promise<SystemEventRow[]> {
  const res = await fetch("/api/activity?limit=50");
  if (!res.ok) {
    throw new Error(`GET /api/activity failed: ${res.status}`);
  }
  const body = (await res.json()) as { events?: SystemEventRow[] };
  return body.events ?? [];
}

/**
 * Most-recent-first list of system events (all categories).
 *
 * `enabled` (mt#2600) pauses BOTH the automatic poll interval and any
 * further fetches — used to pause the live poller while the plant board is
 * in replay mode. Passing `enabled: false` does not clear previously-fetched
 * `data`; a caller that needs a fresh baseline after re-enabling should call
 * the returned `refetch()` explicitly (see PlantFlowPage's exit-replay
 * handler, which re-baselines the gesture engine on a fresh poll).
 */
export function useSystemEvents(intervalMs: number = SYSTEM_EVENTS_POLL_MS, enabled = true) {
  return useQuery({
    queryKey: ["plant-board", "system-events"],
    queryFn: fetchActivity,
    refetchInterval: enabled ? intervalMs : false,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });
}

async function fetchActivityWindow(window: ReplayWindow): Promise<SystemEventRow[]> {
  const params = new URLSearchParams({
    since: window.since,
    until: window.until,
    limit: String(REPLAY_WINDOW_LIMIT),
  });
  const res = await fetch(`/api/activity?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`GET /api/activity (replay window) failed: ${res.status}`);
  }
  const body = (await res.json()) as { events?: SystemEventRow[] };
  return body.events ?? [];
}

/**
 * One-shot fetch of a fixed `[since, until]` window for time-scrubber replay
 * (mt#2600). Disabled (no fetch) while `window` is null — the default state
 * before the operator commits a scrub selection. Does not poll: a replayed
 * window is a fixed historical slice, not a live tail.
 */
export function useReplayEvents(window: ReplayWindow | null) {
  return useQuery({
    queryKey: ["plant-board", "system-events-replay", window?.since, window?.until],
    queryFn: () => fetchActivityWindow(window as ReplayWindow),
    enabled: window !== null,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
