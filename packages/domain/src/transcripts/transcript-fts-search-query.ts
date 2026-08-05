/**
 * Query-shaping helpers for TranscriptFtsService.searchText().
 *
 * Extracted from the service so the decisions that don't need a database —
 * which tsquery parser a mode selects, how a literal is escaped before it
 * reaches an ILIKE pattern, where a snippet window is cut — are pure functions
 * with direct unit tests, rather than behavior only observable by patching a
 * DB client.
 *
 * @see mt#3713 — phrase/literal matching + snippets
 */

// ── Modes ─────────────────────────────────────────────────────────────────────

/**
 * How a query string is turned into a match condition.
 *
 * - `websearch` — `websearch_to_tsquery`. Understands `"quoted phrase"`
 *   (adjacency), `or`, and `-negation` directly in the query text. The default.
 * - `plain` — `plainto_tsquery`. Reduces the query to an AND of stemmed
 *   lexemes with no adjacency. The behavior this surface had before mt#3713,
 *   retained for callers that depend on it.
 * - `exact` — case-insensitive literal substring. No stemming, punctuation
 *   preserved.
 *
 * `websearch` and `plain` are NOT equivalent even for a query with no operator
 * syntax: Postgres's websearch parser treats a punctuation-joined token run
 * (`MINSKY_SKIP_FRESHNESS`) as a phrase, where plainto ANDs the pieces. The
 * measured comparison is recorded in mt#3713's spec.
 */
export type TranscriptFtsSearchMode = "websearch" | "plain" | "exact";

export const DEFAULT_FTS_SEARCH_MODE: TranscriptFtsSearchMode = "websearch";

const FTS_SEARCH_MODES: readonly TranscriptFtsSearchMode[] = ["websearch", "plain", "exact"];

/**
 * Narrow arbitrary input to a search mode, falling back to the default.
 *
 * Used by the surfaces that take a mode from untrusted input (an HTTP query
 * string, a CLI flag) so an unrecognized value degrades to the default rather
 * than erroring.
 */
export function parseSearchMode(raw: unknown): TranscriptFtsSearchMode {
  return FTS_SEARCH_MODES.includes(raw as TranscriptFtsSearchMode)
    ? (raw as TranscriptFtsSearchMode)
    : DEFAULT_FTS_SEARCH_MODE;
}

/**
 * The Postgres text-search function a mode parses its query with.
 *
 * `exact` matches by substring rather than by tsquery, but still names a
 * parser here: it uses the resulting tsquery as an index-accelerated
 * PREFILTER ahead of the substring test (see the service).
 */
export function tsQueryFunctionFor(mode: TranscriptFtsSearchMode): string {
  return mode === "plain" ? "plainto_tsquery" : "websearch_to_tsquery";
}

// ── LIKE escaping ─────────────────────────────────────────────────────────────

/** The escape character declared alongside every ILIKE pattern this module builds. */
export const LIKE_ESCAPE_CHAR = "\\";

/**
 * Escape a user-supplied literal for safe use inside an ILIKE pattern.
 *
 * `%` and `_` are LIKE wildcards, and a great many of the literals worth
 * searching for in a transcript contain `_` (`MINSKY_SKIP_FRESHNESS`,
 * `agent_transcript_turns`). Left unescaped, `_` silently matches any single
 * character, so `exact` would not be exact. The backslash itself is escaped
 * first so it cannot form an unintended escape sequence.
 *
 * Pairs with `ESCAPE '\'` on the SQL side.
 */
export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE_CHAR}${char}`);
}

/** Wrap an escaped literal as a contains-pattern. */
export function buildContainsPattern(literal: string): string {
  return `%${escapeLikeLiteral(literal)}%`;
}

// ── Snippets ──────────────────────────────────────────────────────────────────

/** Characters of context kept on each side of a literal match. */
export const SNIPPET_CONTEXT_CHARS = 90;

/** Hard ceiling on a generated snippet, excluding ellipses. */
export const SNIPPET_MAX_CHARS = 240;

/** Marks the start of a matched span inside a snippet. */
export const SNIPPET_MATCH_START = "[";

/** Marks the end of a matched span inside a snippet. */
export const SNIPPET_MATCH_END = "]";

/**
 * `ts_headline` options for the tsquery modes.
 *
 * Delimiters match {@link SNIPPET_MATCH_START} / {@link SNIPPET_MATCH_END} so a
 * snippet reads the same regardless of which mode produced it.
 */
export const TS_HEADLINE_OPTIONS = [
  "MaxFragments=2",
  "MaxWords=28",
  "MinWords=8",
  `StartSel=${SNIPPET_MATCH_START}`,
  `StopSel=${SNIPPET_MATCH_END}`,
  "FragmentDelimiter= … ",
].join(",");

/**
 * Cut a snippet around the first case-insensitive occurrence of `literal`.
 *
 * Used for `exact` mode, where `ts_headline` is the wrong tool: it highlights
 * tsquery lexemes, and an exact search deliberately bypasses tokenization.
 *
 * Returns a leading/trailing `…` when the window is cut from a longer text, so
 * a truncated snippet is visibly truncated. When the literal is absent (the
 * caller matched on a different field, or the text is null) the head of the
 * text is returned rather than an empty string — a snippet is a preview, and
 * an empty preview is less useful than an unhighlighted one.
 */
export function buildLiteralSnippet(text: string | null | undefined, literal: string): string {
  const source = text ?? "";
  if (source === "") return "";

  const at = literal === "" ? -1 : source.toLowerCase().indexOf(literal.toLowerCase());
  if (at < 0) return truncateHead(source);

  const start = Math.max(0, at - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(source.length, at + literal.length + SNIPPET_CONTEXT_CHARS);

  const before = source.slice(start, at);
  const matched = source.slice(at, at + literal.length);
  const after = source.slice(at + literal.length, end);

  const body = `${before}${SNIPPET_MATCH_START}${matched}${SNIPPET_MATCH_END}${after}`;
  return `${start > 0 ? "… " : ""}${body}${end < source.length ? " …" : ""}`;
}

function truncateHead(source: string): string {
  return source.length <= SNIPPET_MAX_CHARS ? source : `${source.slice(0, SNIPPET_MAX_CHARS)} …`;
}

/**
 * Pick the text an `exact`-mode snippet should be cut from.
 *
 * A turn carries user text, assistant text, or both, and the literal may be in
 * either. Prefer whichever actually contains it; fall back to the first
 * non-empty one so a snippet is always produced.
 */
export function selectLiteralSnippetSource(
  userText: string | null,
  assistantText: string | null,
  literal: string
): string | null {
  const needle = literal.toLowerCase();
  const candidates = [userText, assistantText];

  if (needle !== "") {
    const hit = candidates.find((text) => text != null && text.toLowerCase().includes(needle));
    if (hit != null) return hit;
  }

  return candidates.find((text) => text != null && text !== "") ?? null;
}
