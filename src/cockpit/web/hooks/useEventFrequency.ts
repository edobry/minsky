/**
 * useEventFrequency — shared hook that turns a `system_events` stream into a
 * bucketed sparkline series (mt#2601, /vitals loop cards).
 *
 * Reuses the existing `/api/activity` endpoint (mt#2092/mt#2340 — the same
 * one useSystemEvents.ts polls for the plant board's fast-clock gestures) —
 * no new server.ts route. Filters to a single `eventType` and buckets the
 * returned rows into fixed-width time windows, oldest -> newest, so callers
 * get a real (not fabricated) recent-activity trend: e.g. "memory.created"
 * bucketed over the last 2h approximates a memory-creation-rate sparkline.
 *
 * This is a genuine trend of EVENT ARRIVALS, not a literal snapshot-over-time
 * of a gauge/queue depth (that would require historical snapshots the system
 * doesn't persist) — callers should label sparklines built from this hook as
 * "recent activity," which is what the underlying data actually represents.
 *
 * Query key: ["vitals", "event-frequency", eventType]
 * staleTime: 15s, refetchInterval: 30s (matches the general vitals breath
 * cadence — see VitalsPage.tsx).
 */
import { useQuery } from "@tanstack/react-query";

export interface EventFrequencyOptions {
  /** Total lookback window, milliseconds. Default 2h. */
  windowMs?: number;
  /** Number of equal-width buckets across the window. Default 12. */
  bucketCount?: number;
  /** Max rows to request from /api/activity. Default 200. */
  limit?: number;
}

export interface EventFrequencySnapshot {
  /** Bucketed counts, oldest -> newest; length === bucketCount. */
  buckets: number[];
  /** Total matching events returned within the fetch (bounded by `limit`). */
  total: number;
}

interface ActivityEventRow {
  eventType: string;
  createdAt: string;
}

interface ActivityListResponse {
  events: ActivityEventRow[];
}

const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_BUCKET_COUNT = 12;
const DEFAULT_LIMIT = 200;

async function fetchEventFrequency(
  eventType: string,
  windowMs: number,
  bucketCount: number,
  limit: number
): Promise<EventFrequencySnapshot> {
  const res = await fetch(
    `/api/activity?eventType=${encodeURIComponent(eventType)}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`activity API: ${res.status}`);
  const body = (await res.json()) as ActivityListResponse;

  const buckets = new Array<number>(bucketCount).fill(0);
  const now = Date.now();
  const bucketWidthMs = windowMs / bucketCount;

  let total = 0;
  for (const event of body.events) {
    const createdAtMs = new Date(event.createdAt).getTime();
    if (Number.isNaN(createdAtMs)) continue;
    const ageMs = now - createdAtMs;
    if (ageMs < 0 || ageMs > windowMs) continue;
    total++;
    // bucketIndexFromNow: 0 = most-recent bucket. Convert to oldest-first index.
    const bucketIndexFromNow = Math.floor(ageMs / bucketWidthMs);
    const idx = bucketCount - 1 - bucketIndexFromNow;
    if (idx >= 0 && idx < bucketCount) buckets[idx]++;
  }

  return { buckets, total };
}

/** Bucketed recent-arrival counts for a single `system_events` eventType. */
export function useEventFrequency(eventType: string, options?: EventFrequencyOptions) {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const bucketCount = options?.bucketCount ?? DEFAULT_BUCKET_COUNT;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  return useQuery({
    queryKey: ["vitals", "event-frequency", eventType, windowMs, bucketCount, limit],
    queryFn: () => fetchEventFrequency(eventType, windowMs, bucketCount, limit),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
