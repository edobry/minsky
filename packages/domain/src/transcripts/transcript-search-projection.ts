/**
 * Result projection for the transcript search tools (mt#4917).
 *
 * ## What this exists for
 *
 * `TranscriptTurnResult` carries `userText` / `assistantText` in full, and a
 * transcript turn is not a small object: measured against the repo project on
 * 2026-09-02, the mean turn is 935 characters but p99 is **23,344** and the
 * largest is **690,525**. A handful of hits is therefore enough to blow a
 * transport budget — `transcripts_search-text` returned **5.67 MB at its
 * DEFAULT `limit: 10`** and 5.92 MB at `limit: 20`, against mt#4749's 2 MB
 * `MAX_TOOL_RESPONSE_TEXT_BYTES`. Every one of those spooled to disk, and the
 * caller then had to `jq` the spool file — the "read the raw file instead of
 * using the tool" fallback these tools exist to prevent.
 *
 * Dropping exactly `userText` and `assistantText`, and changing nothing else,
 * takes that 5.92 MB to **19.5 KB**. The bounded `snippet` mt#3713 added is
 * already computed and already on every FTS row; it was simply shipped BESIDE
 * the full text rather than instead of it.
 *
 * ## Why a projection rather than the existing wire bound
 *
 * `boundWireResult` (mt#4418, `src/adapters/mcp/bound-wire-result.ts`) is the
 * obvious-looking answer and it does nothing here — checked, not assumed. Its
 * two passes elide fields byte-identical to CALLER INPUT (transcript text is
 * not caller input) and cap arrays longer than `MAX_WIRE_ARRAY` = 50 (an
 * 18-element result is under it). The defect is per-ELEMENT size, which that
 * module has no pass for. mt#4657 had already established the precedent for
 * this shape of answer: for a too-large result, a projection rather than a cap.
 *
 * ## Why this is applied at the COMMAND layer, not in the services
 *
 * The cockpit's conversation-search route (`src/cockpit/routes/conversation-search.ts`)
 * calls `TranscriptFtsService` / `TranscriptSimilarityService` DIRECTLY, bypassing
 * the shared-command layer entirely, and `ConversationSearchPanel.tsx` renders
 * `turn.snippet?.trim() || (turn.userText ?? turn.assistantText ?? "")`. If the
 * services withheld text by default, that fallback chain would evaluate to `""`
 * for every semantic-mode row and the panel would render blank. So the services
 * keep returning full rows, and only the two MCP/CLI commands project.
 *
 * @see mt#4917 — this module
 * @see mt#3713 — shipped `snippet` beside the full text; this is its follow-on
 * @see mt#4749 — the 2 MB response-safety limit and the spool path
 * @see mt#2818 — `transcripts_get`'s `projection` parameter, the sibling pattern
 */

import type {
  TranscriptSessionMetadata,
  TranscriptTurnResult,
} from "./transcript-similarity-service";

/**
 * Which shape a search tool returns.
 *
 * `snippet` is the default. The value names are deliberately NOT
 * `transcripts_get`'s `full` / `text` pair: that tool's `text` projection
 * returns the turn's COMPLETE text in a leaner envelope, whereas this one
 * returns a bounded EXCERPT. Reusing `text` would claim more than it delivers.
 */
export type TranscriptSearchProjection = "snippet" | "full";

export const DEFAULT_TRANSCRIPT_SEARCH_PROJECTION: TranscriptSearchProjection = "snippet";

/**
 * Which side(s) of the turn carried text, derived before the text is dropped.
 *
 * Load-bearing rather than decorative: with `userText` and `assistantText` both
 * omitted, a caller has no other way to tell whose turn it was — the role is
 * otherwise implied purely by which of those two fields is non-null. Dropping
 * them without this field would lose the distinction silently.
 *
 * `both` is a real case, not a defensive branch: a turn row holds a user
 * message AND the assistant response to it, and the `role` search filter tests
 * only that the corresponding column IS NOT NULL.
 */
export type TranscriptTurnRole = "user" | "assistant" | "both" | "none";

/**
 * A search hit with its text replaced by the bounded excerpt.
 *
 * Everything that is not the turn body is preserved, so the coordinates needed
 * to fetch the full turn survive the projection.
 *
 * **Note the field/parameter rename across that hop**: this row's
 * `agentSessionId` is what `transcripts_get` takes as `conversationId`. Both
 * name the same harness conversation; the two surfaces differ because ADR-022
 * renamed the concept for NEW parameters while leaving existing result fields
 * on the old name. Spell the mapping out wherever it is documented rather than
 * naming only one side — a caller who reads "pass the conversationId" will
 * look for a `conversationId` field on this row and not find one.
 */
export interface TranscriptTurnSnippetResult {
  agentSessionId: string;
  turnIndex: number;
  /** Derived from the omitted text — see {@link TranscriptTurnRole}. */
  role: TranscriptTurnRole;
  userOrigin: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean | null;
  score: number;
  /** The bounded excerpt. Empty string when the producer computed none. */
  snippet: string;
  /**
   * How many characters of `userText` + `assistantText` this projection
   * dropped, so a caller can judge whether the full turn is worth fetching
   * without having to fetch it to find out.
   */
  omittedTextChars: number;
  sessionMetadata: TranscriptSessionMetadata;
  resumeHint: string;
}

/** Derive the role from the text fields, before they are dropped. */
export function deriveTurnRole(
  userText: string | null,
  assistantText: string | null
): TranscriptTurnRole {
  if (userText !== null && assistantText !== null) return "both";
  if (userText !== null) return "user";
  if (assistantText !== null) return "assistant";
  return "none";
}

/** Project one hit into the snippet shape. */
export function projectTurnResult(result: TranscriptTurnResult): TranscriptTurnSnippetResult {
  return {
    agentSessionId: result.agentSessionId,
    turnIndex: result.turnIndex,
    role: deriveTurnRole(result.userText, result.assistantText),
    userOrigin: result.userOrigin,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    isSpawnBoundary: result.isSpawnBoundary,
    score: result.score,
    snippet: result.snippet ?? "",
    omittedTextChars: (result.userText?.length ?? 0) + (result.assistantText?.length ?? 0),
    sessionMetadata: result.sessionMetadata,
    resumeHint: result.resumeHint,
  };
}

/** A search hit in whichever shape the caller's projection selected. */
export type TranscriptTurnResultOrSnippet = TranscriptTurnResult | TranscriptTurnSnippetResult;

/**
 * Project a result set, or return it untouched under the `full` projection.
 *
 * Returns the SAME array reference for `full` so the common "caller wanted
 * everything" path allocates nothing.
 *
 * The return type is an array-of-union rather than a union-of-arrays on
 * purpose: TypeScript cannot infer a generic `T` from `A[] | B[]`, so the
 * union-of-arrays form does not thread through `buildSearchResponse<T>` and
 * every call site would need a cast. An array whose elements are either shape
 * is also the more honest description of what a caller holds.
 */
export function projectTurnResults(
  results: TranscriptTurnResult[],
  projection: TranscriptSearchProjection
): TranscriptTurnResultOrSnippet[] {
  if (projection === "full") return results;
  return results.map(projectTurnResult);
}

/**
 * Coerce an unvalidated `projection` parameter to a known value.
 *
 * The command layer's Zod enum already rejects anything else, so this is the
 * belt to that braces: an absent value takes the default rather than
 * inheriting `undefined` into a comparison.
 */
export function parseSearchProjection(value: unknown): TranscriptSearchProjection {
  return value === "full" ? "full" : DEFAULT_TRANSCRIPT_SEARCH_PROJECTION;
}
