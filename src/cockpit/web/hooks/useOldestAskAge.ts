/**
 * useOldestAskAge — shared hook for the /vitals attention loop's "how long
 * has the oldest pending ask been waiting" metric (mt#2601).
 *
 * Reuses the existing `/api/asks` endpoint (mt#1916 — "list all pending
 * operator-routed asks", already consumed by AsksPage.tsx) rather than
 * introducing a new server.ts route. Note this is a DIFFERENT source than
 * useOpenAskCount.ts (which reads the `attention` widget's `cohort` field —
 * scoped to the active service window when one is open); `/api/asks` always
 * returns the FULL pending-operator-ask set, so it is the correct source for
 * "oldest across everything currently pending," independent of window state.
 *
 * Query key: ["vitals", "oldest-ask-age"]
 * staleTime: 5s, refetchInterval: 10s (matches useOpenAskCount's cadence so
 * the attention card's two numbers never drift out of sync with each other).
 */
import { useQuery } from "@tanstack/react-query";

interface AskListItem {
  createdAt: string;
}

interface AskListResponse {
  asks: AskListItem[];
}

async function fetchOldestAskAgeMs(): Promise<number | null> {
  const res = await fetch("/api/asks");
  if (!res.ok) throw new Error(`asks API: ${res.status}`);
  const body = (await res.json()) as AskListResponse;
  if (body.asks.length === 0) return null;
  const now = Date.now();
  let oldestMs = -Infinity;
  for (const ask of body.asks) {
    const ageMs = now - new Date(ask.createdAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > oldestMs) oldestMs = ageMs;
  }
  return Number.isFinite(oldestMs) ? oldestMs : null;
}

export function useOldestAskAge() {
  return useQuery({
    queryKey: ["vitals", "oldest-ask-age"],
    queryFn: fetchOldestAskAgeMs,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
