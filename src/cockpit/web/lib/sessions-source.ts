/**
 * Shared frontend mirror of the context-inspector sessions-picker payload.
 *
 * The `/api/widget/context-inspector/data` widget endpoint returns the
 * top-N known agent sessions used to populate the session picker in both the
 * ContextInspector widget (mt#2023) and the interim ConversationPage (mt#2374).
 * Both surfaces need the same row shape + payload guard; keeping a single
 * definition here prevents the two inline mirrors from drifting (PR #1645 R1).
 *
 * Mirror of the backend `ContextInspectorSessionRow`; kept in sync by hand
 * (the frontend bundle does not import server code).
 */
import type { WidgetData } from "./widget-client";

/** One row in the sessions picker. */
export interface SessionRow {
  agentSessionId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  label: string;
}

export interface SessionsPayload {
  sessions: SessionRow[];
}

export function isSessionsPayload(payload: unknown): payload is SessionsPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { sessions?: unknown }).sessions)
  );
}

/**
 * Extract the session rows from a widget-data response, returning `[]` for any
 * non-`ok` / unexpected-shape response. Centralizes the "ok + payload shape"
 * unwrap both pickers would otherwise repeat.
 */
export function extractSessionRows(data: WidgetData | undefined): SessionRow[] {
  if (data?.state === "ok" && isSessionsPayload(data.payload)) {
    return data.payload.sessions;
  }
  return [];
}
