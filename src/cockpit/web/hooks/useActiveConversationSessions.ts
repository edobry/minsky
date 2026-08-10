/**
 * useActiveConversationSessions — the set of `agentSessionId`s that are
 * GENUINELY live right now (mt#2749), derived from `GET /api/health`'s
 * `transcriptWatcher.activeSessions` registry
 * (`TranscriptWatcherTracker.getLiveSessions()`, mt#2320 SC2 + mt#3857).
 *
 * Used by `Agents.tsx` (the unified run list, mt#2767 — formerly by the
 * retired `ConversationsPage`) to render a live badge on rows for
 * conversations that are currently being watched/ingested — the operator's
 * way to find a running conversation to open (mt#2749 success criterion 3).
 *
 * Recency filtering happens SERVER-SIDE (mt#3857) — this hook consumes the
 * field as-is. It did not always: the registry's raw contents are NOT
 * "currently active" in the intuitive sense, because
 * `TranscriptWatcher.seedExisting()` stamps every PRE-EXISTING file at boot so
 * the tailer can seed byte offsets (correct for that purpose, but it conflates
 * "the watcher knows this file exists" with "this conversation is live"). This
 * hook was the first consumer to notice, and originally compensated by
 * filtering to a 2-minute window in the browser — AFTER downloading the whole
 * registry. That worked and was quietly expensive: by 2026-08-08 the array had
 * reached 1,380 entries (209 KB), re-sent on every poll of the
 * most-frequently-polled endpoint in the system, so the client discarded
 * essentially all of what it fetched. The window now lives at
 * `LIVE_SESSION_WINDOW_MS` in `transcript-watcher-tracker.ts` and is applied
 * before serialization; the calibration is unchanged, only its location.
 *
 * Do NOT reintroduce a client-side window here. A second copy of the
 * threshold would drift from the server's, and the two would disagree
 * silently — the badge would be governed by whichever is shorter, with no
 * indication which one is in force.
 *
 * Mirrors `useSystemHealth`'s direct `/api/health` fetch pattern (no
 * server-side shape import on the frontend bundle — a hand-kept mirror type).
 *
 * @see src/cockpit/routes/health.ts — GET /api/health, transcriptWatcher.activeSessions
 * @see src/cockpit/transcript-watcher-tracker.ts — ActiveSessionInfo, LIVE_SESSION_WINDOW_MS, getLiveSessions()
 * @see src/cockpit/transcript-watcher.ts — seedExisting(), the boot-scan root cause
 * @see src/cockpit/web/widgets/Agents.tsx — consumer (mt#2767 unified run list)
 */
import { useQuery } from "@tanstack/react-query";

/** Frontend-local mirror of `ActiveSessionInfo` (transcript-watcher-tracker.ts) — only the fields this hook needs. */
interface ActiveSessionInfoMirror {
  agentSessionId: string;
}

interface ApiHealthActiveSessionsResponse {
  transcriptWatcher?: {
    activeSessions?: ActiveSessionInfoMirror[];
  };
}

async function fetchActiveConversationSessionIds(): Promise<Set<string>> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`api/health: ${res.status}`);
  const data = (await res.json()) as ApiHealthActiveSessionsResponse;
  const rows = data.transcriptWatcher?.activeSessions ?? [];
  return new Set(rows.map((r) => r.agentSessionId));
}

/**
 * Fetch the set of currently-active conversation agentSessionIds. Short
 * staleTime + refetchInterval (per the cockpit stack's live-signal
 * convention, e.g. `useSystemHealth`) since "active" is a live fact that
 * goes stale quickly.
 */
export function useActiveConversationSessions() {
  return useQuery<Set<string>, Error>({
    queryKey: ["conversations", "active-sessions"],
    queryFn: fetchActiveConversationSessionIds,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
