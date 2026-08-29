/**
 * Conversation content/time search panel (mt#2523).
 *
 * Embedded in the Agents widget — the current "Conversations surface" (the
 * standalone `/conversations` page was retired and folded into Agents.tsx
 * per mt#2767/mt#2767's header comment). Lets an operator find a past
 * conversation by content (FTS default, semantic optional) and/or a time
 * window, then copy a ready, directory-pinned `cd <cwd> && claude --resume <id>`
 * command for the match (mt#3440).
 *
 * User-triggered (not polling) — a plain TanStack `useMutation` against
 * `GET /api/conversations/search`, fired on submit rather than on an
 * interval. A windowed query over an unindexed range surfaces the
 * `coverage.note` returned by the endpoint (mt#2319 SC#4 / mt#2234) instead
 * of rendering a silent "no results".
 *
 * @see src/cockpit/routes/conversation-search.ts — the backend endpoint
 * @see mt#2523 — this panel
 */
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Search, Copy, Check, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { EntityRef } from "../components/EntityRef";
import { Checkbox } from "../components/ui/checkbox";
import { useProject } from "../lib/project-context";

// ---------------------------------------------------------------------------
// Client-side mirror of the server response shape. The server type
// (packages/domain/src/transcripts/transcript-similarity-service.ts
// TranscriptTurnResult) carries `Date | null` fields; over the wire those
// arrive as ISO strings (or null), so this is a deliberately distinct type —
// same convention Agents.tsx uses for its own AgentRow mirror.
// ---------------------------------------------------------------------------

interface ConversationSearchTurn {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  startedAt: string | null;
  score: number;
  resumeHint: string;
  /** Server-built excerpt around the match, matched spans in [brackets] (mt#3713). */
  snippet?: string;
  sessionMetadata: {
    startedAt: string | null;
    model: string | null;
    messageCount: number;
    relatedTaskIds: string[] | null;
  };
}

interface ConversationSearchCoverage {
  unindexedSessionsInWindow: number;
  note?: string;
}

interface ConversationSearchResponse {
  results: ConversationSearchTurn[];
  coverage?: ConversationSearchCoverage;
}

function isConversationSearchResponse(payload: unknown): payload is ConversationSearchResponse {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { results?: unknown }).results)
  );
}

/** How the FTS backend matches the query. Ignored when `semantic` is set. */
type TextMatchMode = "websearch" | "plain" | "exact";

interface SearchParams {
  query: string;
  from: string;
  to: string;
  semantic: boolean;
  textMode: TextMatchMode;
  /** Selected project's slug, or undefined for "All projects" (mt#4731). */
  project?: string;
}

async function runConversationSearch(params: SearchParams): Promise<ConversationSearchResponse> {
  const qs = new URLSearchParams();
  qs.set("q", params.query);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.semantic) qs.set("mode", "semantic");
  if (!params.semantic) qs.set("textMode", params.textMode);
  if (params.project) qs.set("project", params.project);

  const res = await fetch(`/api/conversations/search?${qs.toString()}`);
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Search failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  if (!isConversationSearchResponse(body)) {
    throw new Error("Unexpected response shape from /api/conversations/search");
  }
  return body;
}

// ---------------------------------------------------------------------------
// Small helpers (mirrors formatting helpers already used by Agents.tsx —
// duplicated locally rather than exported/shared, since both are tiny and
// this keeps the panel a self-contained, easily-relocatable widget)
// ---------------------------------------------------------------------------

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function snippetFor(turn: ConversationSearchTurn): string {
  // Prefer the server-built excerpt (mt#3713): it is cut around the MATCH,
  // where the local fallback below only takes the head of the turn and so can
  // show nothing related to the query at all.
  const source = turn.snippet?.trim() || (turn.userText ?? turn.assistantText ?? "");
  const text = source.trim().replace(/\s+/g, " ");
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard resume button
// ---------------------------------------------------------------------------

function CopyResumeButton({ resumeHint }: { resumeHint: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(resumeHint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [resumeHint]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy resume command"
      aria-label="Copy resume command"
      className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors flex-shrink-0"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Restore-transcript button (mt#4573)
// ---------------------------------------------------------------------------

/** Human-readable result for each outcome the rehydrate route can return. */
const RESTORE_LABELS: Record<string, string> = {
  rehydrated: "Restored",
  "already-present": "Already there",
  "nothing-captured": "Nothing stored",
  "no-recorded-cwd": "No directory",
};

/**
 * Rebuild this conversation's on-disk transcript so `claude --resume` works
 * again (mt#4573).
 *
 * Sits beside the copy button rather than replacing it: the resume command is
 * still what the operator runs, and this makes it work when Claude Code has
 * reaped the transcript out from under it.
 *
 * Deliberately NOT gated on knowing in advance whether the file is missing. The
 * route answers that itself — `already-present` is a 200, because the question
 * the operator is asking is "can I resume this?", and the answer is yes. Gating
 * would mean shipping a resumability probe per row (mt#3438's territory) to
 * decide whether to render a button that is harmless either way.
 */
function RestoreTranscriptButton({ conversationId }: { conversationId: string }) {
  const [result, setResult] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/conversations/${conversationId}/rehydrate`, {
        method: "POST",
      });
      return (await res.json()) as { status?: string; outcome?: string };
    },
    onSuccess: (body) => {
      const key = body.status ?? body.outcome ?? "";
      setResult(RESTORE_LABELS[key] ?? "Failed");
      setTimeout(() => setResult(null), 3000);
    },
    onError: () => {
      setResult("Failed");
      setTimeout(() => setResult(null), 3000);
    },
  });

  return (
    <button
      type="button"
      onClick={() => restore.mutate()}
      disabled={restore.isPending}
      title="Rebuild this conversation's transcript on disk so it can be resumed"
      aria-label="Restore transcript"
      className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors flex-shrink-0 disabled:opacity-50"
    >
      <RotateCcw className="h-3 w-3" />
      {result ?? (restore.isPending ? "Restoring" : "Restore")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

function ConversationSearchResultRow({ turn }: { turn: ConversationSearchTurn }) {
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-border/60 last:border-0">
      <div className="flex items-center gap-2">
        {/* No nesting complication (unlike Attention.tsx's DigestRow) — this
            row is not itself a Link. Children mode preserves the exact prior
            truncated visual (mt#3187); the hover card adds the conversation's
            resolved label where the native `title` tooltip previously only
            repeated the id. */}
        <EntityRef type="conversation" id={turn.agentSessionId} className="text-xs truncate">
          {turn.agentSessionId}
        </EntityRef>
        {turn.sessionMetadata.model && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
            {turn.sessionMetadata.model}
          </span>
        )}
        <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums ml-auto">
          {formatRelative(turn.startedAt ?? turn.sessionMetadata.startedAt)}
        </span>
      </div>
      <p className="text-sm text-foreground/90 truncate">{snippetFor(turn)}</p>
      <div className="flex items-center gap-2">
        <code className="text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground flex-1 min-w-0 truncate">
          {turn.resumeHint}
        </code>
        <CopyResumeButton resumeHint={turn.resumeHint} />
        <RestoreTranscriptButton conversationId={turn.agentSessionId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ConversationSearchPanel() {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [textMode, setTextMode] = useState<TextMatchMode>("websearch");
  const [submitted, setSubmitted] = useState(false);

  const { queryParam: projectParam } = useProject();
  const mutation = useMutation({ mutationFn: runConversationSearch });

  const handleSearch = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;
      setSubmitted(true);
      mutation.mutate({
        query: trimmed,
        from,
        to,
        semantic,
        textMode,
        project: projectParam?.project,
      });
    },
    [query, from, to, semantic, textMode, projectParam]
  );

  return (
    <div className="mb-2 border border-border rounded-md">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Search className="h-3.5 w-3.5" />
        Search conversation content
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          <form onSubmit={handleSearch} className="flex flex-wrap items-center gap-2 mb-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                semantic
                  ? "Search conversation content…"
                  : textMode === "exact"
                    ? "Exact text, e.g. MINSKY_SKIP_FRESHNESS"
                    : 'Words, or "an exact phrase" in quotes'
              }
              className="flex-1 min-w-[12rem] text-xs bg-background border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="Search query"
            />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="To date"
            />
            {/* Match mode applies to the text backend only — semantic search
                embeds the whole query and has no notion of phrase or literal. */}
            {!semantic && (
              <select
                value={textMode}
                onChange={(e) => setTextMode(e.target.value as TextMatchMode)}
                className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Text match mode"
              >
                <option value="websearch">Phrase</option>
                <option value="plain">All words</option>
                <option value="exact">Exact</option>
              </select>
            )}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <Checkbox checked={semantic} onCheckedChange={(v) => setSemantic(v === true)} />
              Semantic
            </label>
            <Button type="submit" size="sm" className="h-6 text-xs px-2" disabled={!query.trim()}>
              Search
            </Button>
          </form>

          {submitted && mutation.isPending && (
            <p className="text-xs text-muted-foreground">Searching…</p>
          )}

          {submitted && mutation.isError && (
            <p role="alert" className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Search failed"}
            </p>
          )}

          {submitted && mutation.isSuccess && (
            <>
              {mutation.data.coverage?.note && (
                <div
                  role="status"
                  className="mb-2 text-xs px-2 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-600"
                >
                  {mutation.data.coverage.note}
                </div>
              )}
              {mutation.data.results.length === 0 ? (
                <p className="text-xs text-muted-foreground">No matching conversations found.</p>
              ) : (
                <div>
                  {mutation.data.results.map((turn) => (
                    <ConversationSearchResultRow
                      key={`${turn.agentSessionId}:${turn.turnIndex}`}
                      turn={turn}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
