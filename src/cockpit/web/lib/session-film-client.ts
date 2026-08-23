/**
 * TanStack Query fetchers for the session-film backend endpoints (mt#3184).
 *
 * Mirrors `conversation-snapshot.ts`'s discipline: parse the `{error:{code,
 * message}}` shape on failure, carry status+code on a typed Error subclass,
 * and export the query keys every consumer must share.
 */
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { snapshotBlockToConversationTurn } from "@minsky/domain/transcripts/conversation-elements";
import type { PreparedElement } from "../components/ConversationElementRenderers";

export class SessionFilmError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "SessionFilmError";
  }
}

async function parseErrorResponse(res: Response): Promise<never> {
  const raw = await res.text();
  let code: string | undefined;
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
    if (parsed.error && typeof parsed.error === "object") {
      if (typeof parsed.error.code === "string") code = parsed.error.code;
      if (typeof parsed.error.message === "string") detail = parsed.error.message;
    }
  } catch {
    // Non-JSON body — keep the raw text as the detail.
  }
  throw new SessionFilmError(res.status, code, detail);
}

export interface SessionFilmEventsResponse {
  events: SemanticEvent[];
  ingestedAt: string | null;
}

export async function fetchSessionFilmEvents(
  conversationId: string
): Promise<SessionFilmEventsResponse> {
  const params = new URLSearchParams({ conversationId });
  const res = await fetch(`/api/cockpit/session-film/events?${params.toString()}`);
  if (!res.ok) await parseErrorResponse(res);
  return (await res.json()) as SessionFilmEventsResponse;
}

export function sessionFilmEventsQueryKey(
  conversationId: string
): readonly [string, string, string] {
  return ["session-film", "events", conversationId] as const;
}

/** Do NOT retry a client error (4xx) — mirrors conversation-snapshot.ts's snapshotRetry rationale. */
export function sessionFilmRetry(failureCount: number, error: Error): boolean {
  const status = error instanceof SessionFilmError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 3;
}

// ── Film-owned content fetch (mt#3262 SC 2 / SC 5) ──────────────────────────

export interface SessionFilmContentResponse {
  blocks: SessionContextSnapshotBlock[];
  ingestedAt: string | null;
}

/**
 * Fetch the transcript content for a conversation, whole (not per-row) — one
 * call per first-expand, then indexed in memory by the ribbon. Mirrors
 * `fetchSessionFilmEvents`'s error-parsing discipline. Deliberately hits
 * `/api/cockpit/session-film/content`, never
 * `/api/cockpit/context-inspector/snapshot` — see `session-film.ts`'s module
 * doc comment for why (spec SC 5).
 */
export async function fetchSessionFilmContent(
  conversationId: string
): Promise<SessionFilmContentResponse> {
  const params = new URLSearchParams({ conversationId });
  const res = await fetch(`/api/cockpit/session-film/content?${params.toString()}`);
  if (!res.ok) await parseErrorResponse(res);
  return (await res.json()) as SessionFilmContentResponse;
}

export function sessionFilmContentQueryKey(
  conversationId: string
): readonly [string, string, string] {
  return ["session-film", "content", conversationId] as const;
}

// ── Event → real content resolution (mt#3262 SC 2) ──────────────────────────

/**
 * Resolve one `SemanticEvent`'s real content — the thinking text, message
 * text, or tool call params+result an expanded ribbon row renders — from the
 * content endpoint's `blocks`, using the event's `sourceRef`.
 *
 * Reuses `snapshotBlockToConversationTurn` (the SAME domain parser
 * ConversationView's `ConversationThread` runs over the full snapshot) on
 * the SINGLE block at `sourceRef.turnIndex` — never a parallel re-parse of
 * the raw JSONL. For a tool-call-derived event, the paired result (if any)
 * is looked up on the FOLLOWING turnIndex's block, mirroring the adapter's
 * own pairing algorithm (`event-adapter.ts`'s "immediately following
 * user-role line" rule).
 *
 * Returns `null` when the event carries no `sourceRef`, the referenced block
 * is missing (pre-content-capture / windowed-out session — spec AT 4), or
 * the specific sub-element (by kind, or by `toolUseId` for a tool call)
 * can't be found within that block's parsed turn — callers render a
 * "content unavailable" state for `null`, never crash.
 */
export function resolveEventContent(
  blocks: readonly SessionContextSnapshotBlock[] | undefined,
  event: SemanticEvent
): PreparedElement | null {
  const sourceRef = event.sourceRef;
  if (!blocks || !sourceRef) return null;

  const block = blocks.find((b) => b.turnIndex === sourceRef.turnIndex);
  if (!block) return null;
  const turn = snapshotBlockToConversationTurn(block);
  if (!turn) return null;

  if (event.verb === "think") {
    const el = turn.elements.find((e) => e.kind === "thinking");
    return el && el.kind === "thinking" ? { kind: "thinking", thinking: el.thinking } : null;
  }

  if (event.verb === "speak" || event.verb === "ask") {
    const el = turn.elements.find((e) => e.kind === "text" && e.text.trim().length > 0);
    return el && el.kind === "text" ? { kind: "text", text: el.text } : null;
  }

  // Tool-call-derived verbs (read/search/write/delete/execute/create/spawn/clone):
  // toolUseId disambiguates which call within a possibly-parallel batch.
  if (sourceRef.toolUseId) {
    const call = turn.elements.find((e) => e.kind === "tool-call" && e.id === sourceRef.toolUseId);
    if (!call || call.kind !== "tool-call") return null;

    const nextBlock = blocks.find((b) => b.turnIndex === sourceRef.turnIndex + 1);
    const nextTurn = nextBlock ? snapshotBlockToConversationTurn(nextBlock) : null;
    const result = nextTurn?.elements.find(
      (e) => e.kind === "tool-result" && e.toolUseId === sourceRef.toolUseId
    );

    return {
      kind: "tool-invocation",
      call,
      result: result && result.kind === "tool-result" ? result : undefined,
    };
  }

  return null;
}
