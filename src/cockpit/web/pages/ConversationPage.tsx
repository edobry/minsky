/**
 * ConversationPage — INTERIM full-page host for the conversation renderer (mt#2374).
 *
 * This route (`/conversation`) is an explicitly-interim verification host: it
 * exists so the ConversationView body can be exercised end-to-end against real
 * local sessions UNTIL mt#2370 lands the unified session-tab frame, at which
 * point the ConversationView body moves into that frame and this page route is
 * retired. It deliberately reuses the context-inspector sessions source for the
 * picker rather than introducing a new sessions-list surface (that list is
 * mt#2370's scope, not this task's).
 *
 * The page supplies the chrome (heading + picker); ConversationView is the
 * layout-agnostic body.
 *
 * @see mt#2374 — conversation renderer
 * @see mt#2370 — the session-tab frame that supersedes this interim host
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConversationView } from "../widgets/ConversationView";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { extractSessionRows } from "../lib/sessions-source";

export function ConversationPage() {
  const sessionsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    staleTime: 30_000,
  });

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sessions = extractSessionRows(sessionsQuery.data);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Conversation</h1>
        <p className="text-xs text-muted-foreground">
          Readable chat-thread view of a session transcript. Interim host (mt#2374) — moves into the
          session tab when mt#2370 lands.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Session</label>
        <select
          className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          value={selectedSessionId ?? ""}
          onChange={(e) => setSelectedSessionId(e.target.value || null)}
        >
          <option value="">— select —</option>
          {sessions.map((s) => (
            <option key={s.agentSessionId} value={s.agentSessionId}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {sessionsQuery.isError && (
        <p className="text-sm text-muted-foreground">
          Failed to load sessions: {sessionsQuery.error.message}
        </p>
      )}

      {selectedSessionId === null ? (
        <p className="text-sm text-muted-foreground">Select a session to read its conversation.</p>
      ) : (
        <ConversationView sessionId={selectedSessionId} />
      )}
    </div>
  );
}
