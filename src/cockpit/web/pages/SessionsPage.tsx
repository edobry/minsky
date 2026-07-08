/**
 * SessionsPage — `/sessions`, the readable-session list (mt#2420).
 *
 * Lists harness transcript sessions (the entities that HAVE a readable
 * conversation, keyed by `agentSessionId`) from the context-inspector source.
 * Each row opens `/session/:agentSessionId` — which renders the conversation.
 *
 * This is distinct from `/agents` (the workspace/agent-in-flight view, keyed by
 * the Minsky workspace `sessionId`, a different id-space). mt#2398 conflated the
 * two and linked `/agents` rows to `/session/:workspaceId`, which 404'd because
 * a workspace id is not a transcript id (mt#2420). The readable "Sessions"
 * surface is this page.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { extractSessionRows } from "../lib/sessions-source";
import { cn } from "../lib/utils";

export function SessionsPage() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    staleTime: 30_000,
  });

  const sessions = extractSessionRows(query.data);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Conversations</h1>
        <p className="text-xs text-muted-foreground">
          Readable harness conversation transcripts. Open one to read its conversation as a tab.
        </p>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
      {query.isError && (
        <p className="text-sm text-muted-foreground">
          Failed to load conversations: {query.error.message}
        </p>
      )}
      {!query.isLoading && !query.isError && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No ingested conversation transcripts yet.</p>
      )}

      <div className="flex flex-col">
        {sessions.map((s) => (
          <Link
            key={s.agentSessionId}
            to={`/session/${encodeURIComponent(s.agentSessionId)}`}
            aria-label={`Open conversation ${s.label}`}
            className={cn(
              "flex items-center gap-3 rounded-sm border-b border-border px-1 py-2 text-sm last:border-0",
              "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <Bot aria-hidden className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.label}</div>
              {s.cwd && <div className="truncate text-xs text-muted-foreground">{s.cwd}</div>}
            </div>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {s.agentSessionId.slice(0, 8)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
