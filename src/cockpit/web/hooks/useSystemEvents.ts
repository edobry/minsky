/**
 * useSystemEvents — polls the cockpit's `/api/activity` endpoint (mt#2092 /
 * mt#2340 system_events substrate) for the plant board's fast-clock motion
 * layer (mt#2377 v2.0).
 *
 * Polling, not SSE: `system_events` emits don't NOTIFY yet (producers pending
 * mt#1854), so `/api/events` SSE would stay silent for these. The poll
 * interval is the fast-clock resolution — gestures fire within one interval
 * of the real transition. mt#2481 owns the SSE upgrade once producers land.
 */
import { useQuery } from "@tanstack/react-query";

export interface SystemEventRow {
  id: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export const SYSTEM_EVENTS_POLL_MS = 8_000;

async function fetchActivity(): Promise<SystemEventRow[]> {
  const res = await fetch("/api/activity?limit=50");
  if (!res.ok) {
    throw new Error(`GET /api/activity failed: ${res.status}`);
  }
  const body = (await res.json()) as { events?: SystemEventRow[] };
  return body.events ?? [];
}

/** Most-recent-first list of system events (all categories). */
export function useSystemEvents(intervalMs: number = SYSTEM_EVENTS_POLL_MS) {
  return useQuery({
    queryKey: ["plant-board", "system-events"],
    queryFn: fetchActivity,
    refetchInterval: intervalMs,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
