/**
 * Shared frontend mirror of the context-inspector conversations-picker payload
 * (renamed from sessions-source.ts per ADR-022 stage 1, mt#2686).
 *
 * The `/api/widget/context-inspector/data` widget endpoint returns the
 * top-N known agent conversations used to populate the conversation picker in
 * both the ContextInspector widget (mt#2023) and the conversation tab
 * (mt#2374's ConversationView, hosted at /conversation/:id since mt#2398,
 * renamed from /session/:id by mt#2686).
 * Both surfaces need the same row shape + payload guard; keeping a single
 * definition here prevents the two inline mirrors from drifting (PR #1645 R1).
 *
 * Mirror of the backend `ContextInspectorSessionRow`; kept in sync by hand
 * (the frontend bundle does not import server code).
 */
import type { WidgetData } from "./widget-client";

/** One row in the conversations picker. */
export interface ConversationRow {
  agentSessionId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  label: string;
}

export interface ConversationsPayload {
  sessions: ConversationRow[];
}

export function isConversationsPayload(payload: unknown): payload is ConversationsPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { sessions?: unknown }).sessions)
  );
}

/**
 * Extract the conversation rows from a widget-data response, returning `[]`
 * for any non-`ok` / unexpected-shape response. Centralizes the "ok + payload
 * shape" unwrap both pickers would otherwise repeat.
 */
export function extractConversationRows(data: WidgetData | undefined): ConversationRow[] {
  if (data?.state === "ok" && isConversationsPayload(data.payload)) {
    return data.payload.sessions;
  }
  return [];
}
