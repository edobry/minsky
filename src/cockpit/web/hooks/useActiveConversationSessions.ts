/**
 * useActiveConversationSessions — the set of `agentSessionId`s the transcript
 * watcher currently considers "active" (mt#2749), sourced from
 * `GET /api/health`'s `transcriptWatcher.activeSessions` registry
 * (`TranscriptWatcherTracker.getActiveSessions()`, mt#2320 SC2).
 *
 * Used by `ConversationsPage` to render a live badge on rows for
 * conversations that are currently being watched/ingested — the operator's
 * way to find a running conversation to open (mt#2749 success criterion 3).
 *
 * Mirrors `useSystemHealth`'s direct `/api/health` fetch pattern (no
 * server-side shape import on the frontend bundle — a hand-kept mirror type).
 *
 * @see src/cockpit/routes/health.ts — GET /api/health, transcriptWatcher.activeSessions
 * @see src/cockpit/transcript-watcher-tracker.ts — ActiveSessionInfo shape
 * @see src/cockpit/web/pages/ConversationsPage.tsx — consumer
 */
import { useQuery } from "@tanstack/react-query";

/** Frontend-local mirror of `ActiveSessionInfo` (transcript-watcher-tracker.ts) — only the field this hook needs. */
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
