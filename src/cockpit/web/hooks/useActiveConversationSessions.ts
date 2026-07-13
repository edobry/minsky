/**
 * useActiveConversationSessions — the set of `agentSessionId`s that are
 * GENUINELY live right now (mt#2749), derived from `GET /api/health`'s
 * `transcriptWatcher.activeSessions` registry
 * (`TranscriptWatcherTracker.getActiveSessions()`, mt#2320 SC2).
 *
 * Used by `ConversationsPage` to render a live badge on rows for
 * conversations that are currently being watched/ingested — the operator's
 * way to find a running conversation to open (mt#2749 success criterion 3).
 *
 * Recency filter (load-bearing — do not drop). `getActiveSessions()`'s raw
 * contents are NOT "currently active" in the intuitive sense: verified live
 * 2026-07-13 on cockpit server boot — EVERY historical conversation the
 * watcher has ever discovered (496 files, some from days earlier) showed
 * `lastEventAt` stamped to the boot timestamp. Root cause:
 * `TranscriptWatcher.seedExisting()` (transcript-watcher.ts) deliberately
 * calls `tracker.recordSessionEvent()` for every PRE-EXISTING file at boot
 * so the tailer can seed byte offsets and skip re-streaming old history —
 * correct for that purpose, but it means raw presence in `activeSessions`
 * conflates "the watcher knows this file exists" with "this conversation is
 * live right now." This hook is the first frontend consumer of
 * `getActiveSessions()`, so the gap was previously invisible. Rather than
 * change the shared tracker (out of scope; other/future consumers may rely
 * on the current stamping-on-discovery behavior), this hook filters to only
 * `lastEventAt` within `LIVE_RECENCY_WINDOW_MS` of now.
 *
 * Window calibration: no prior cadence data exists for "typical gap between
 * turns in an active conversation" (this is a new signal). 2 minutes is
 * chosen as a conservative middle ground — long enough to survive a
 * multi-refetch-cycle gap (staleTime 10s / refetchInterval 15s below) or a
 * longer-running tool call between turns, short enough to clearly exclude
 * the boot-scan's days-old false positives. Revisit if operators report
 * either false negatives (a visibly-active conversation losing its badge
 * mid-turn) or false positives (a stale conversation still showing live
 * past this window).
 *
 * Mirrors `useSystemHealth`'s direct `/api/health` fetch pattern (no
 * server-side shape import on the frontend bundle — a hand-kept mirror type).
 *
 * @see src/cockpit/routes/health.ts — GET /api/health, transcriptWatcher.activeSessions
 * @see src/cockpit/transcript-watcher-tracker.ts — ActiveSessionInfo shape
 * @see src/cockpit/transcript-watcher.ts — seedExisting(), the boot-scan root cause
 * @see src/cockpit/web/pages/ConversationsPage.tsx — consumer
 */
import { useQuery } from "@tanstack/react-query";

/** Frontend-local mirror of `ActiveSessionInfo` (transcript-watcher-tracker.ts) — only the fields this hook needs. */
interface ActiveSessionInfoMirror {
  agentSessionId: string;
  lastEventAt: string | null;
}

interface ApiHealthActiveSessionsResponse {
  transcriptWatcher?: {
    activeSessions?: ActiveSessionInfoMirror[];
  };
}

/** See the module docblock's "Window calibration" note. */
const LIVE_RECENCY_WINDOW_MS = 2 * 60 * 1000;

async function fetchActiveConversationSessionIds(): Promise<Set<string>> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`api/health: ${res.status}`);
  const data = (await res.json()) as ApiHealthActiveSessionsResponse;
  const rows = data.transcriptWatcher?.activeSessions ?? [];
  const now = Date.now();
  const recent = rows.filter((r) => {
    if (!r.lastEventAt) return false;
    const ts = new Date(r.lastEventAt).getTime();
    if (Number.isNaN(ts)) return false;
    return now - ts <= LIVE_RECENCY_WINDOW_MS;
  });
  return new Set(recent.map((r) => r.agentSessionId));
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
