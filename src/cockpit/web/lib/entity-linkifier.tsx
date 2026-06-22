/**
 * Entity linkifier — tokenizes transcript text into React nodes, converting
 * entity references to in-SPA <Link> elements (mt#2518).
 *
 * Two-class strategy:
 *   (a) Explicit `minsky://<type>/<id>` substrings → <Link> routed by PATH via parseMinskyUri.
 *       These resolve even when the id is NOT in the loaded id-set (type is in the URI).
 *   (b) Bare references (mt#NNNN task ids and UUID-shaped tokens) — resolved against a
 *       known-entity id-set via resolveEntityId(); linked ONLY when the token matches a
 *       known entity in the index. A well-formed mt# NOT in the id-set stays plain text
 *       (zero false positives). The id-set must be COMPREHENSIVE (useEntityIndex fetches
 *       /api/tasks?all=true so DONE/CLOSED tasks are included) — see mt#2518 R4.
 *
 * Conservative design (zero false positives):
 *   - Non-matching tokens, `#define`, prefix-less `#2370`, non-entity UUIDs,
 *     `https://` URLs → plain text
 *   - Short/prefix forms (e.g. `bd38be2c`) resolve by unique-prefix match against
 *     the id-set; ambiguous / no-match → plain text
 *   - PR/changeset refs are NOT linkified (no detail route yet — mt#2410)
 *
 * The tokenizer is a pure `string → ReactNode[]` function — no remark/rehype,
 * no markdown, just regex-based tokenization of the plain text.
 *
 * @see entity-codec.ts — the (type, id) ↔ minsky:// URI ↔ path codec
 * @see mt#2518 — this task
 * @see mt#2410 — PR/changeset linkification (future)
 */
import { createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { parseMinskyUri, entityToPath, type RoutableEntityType } from "./entity-codec";

// ---------------------------------------------------------------------------
// Id-set index
// ---------------------------------------------------------------------------

/**
 * A map from entity id → entity type, used to resolve bare references.
 * Built from the data CommandPalette already fetches (tasks/sessions/asks/memories).
 */
export type EntityIndex = Map<string, RoutableEntityType>;

/**
 * Build an EntityIndex from flat lists of ids per type.
 *
 * Pass the same data CommandPalette uses — no new queries needed.
 */
export function buildEntityIndex(opts: {
  taskIds: string[];
  sessionIds: string[];
  askIds: string[];
  memoryIds: string[];
}): EntityIndex {
  const index: EntityIndex = new Map();
  for (const id of opts.taskIds) index.set(id, "task");
  for (const id of opts.sessionIds) index.set(id, "session");
  for (const id of opts.askIds) index.set(id, "ask");
  for (const id of opts.memoryIds) index.set(id, "memory");
  return index;
}

/**
 * Resolve a candidate token against the EntityIndex.
 *
 * Supports:
 *   - Exact match (the full id is in the index)
 *   - Unique-prefix match (the token is a prefix of exactly ONE id in the index)
 *
 * Returns `{type, id}` (the FULL id) on match, null on no-match / ambiguous.
 */
function resolveEntityId(
  token: string,
  index: EntityIndex
): { type: RoutableEntityType; id: string } | null {
  // Exact match wins immediately.
  const exactType = index.get(token);
  if (exactType !== undefined) return { type: exactType, id: token };

  // Prefix match — the token must be a prefix of exactly one known id.
  // Only meaningful for UUID-shaped tokens (≥8 hex chars) to avoid false
  // positives on very short prefixes.
  if (token.length < 8) return null;

  const matches: Array<{ type: RoutableEntityType; id: string }> = [];
  for (const [id, type] of index) {
    if (id.startsWith(token)) {
      matches.push({ type, id });
      if (matches.length > 1) return null; // ambiguous
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Combined token regex. Matches (in priority order):
 *   1. minsky:// URIs — `minsky://` followed by valid URI chars. Trailing prose
 *      punctuation (`.` `,` `)` `]` `;`) that would end a sentence is excluded via
 *      a character-class that requires each char to be followed by a non-punct char
 *      or be a non-punct char itself (effectively: greedy match stops before a
 *      trailing punctuation sequence).
 *   2. Task ids — `mt#\d+` with a negative lookbehind `(?<![a-zA-Z0-9_])` so
 *      "fmt#123" is not matched, and `\b` after digits so "mt#123abc" is not.
 *      Bare `#2370` (no `mt` prefix) is never matched.
 *   3. UUID-shaped tokens:
 *      a. Full UUID: `[0-9a-f]{8}-...-[0-9a-f]{12}` — naturally bounded by hyphens
 *         and non-hex chars.
 *      b. 8-char hex prefix: exactly 8 lowercase hex chars bounded by `(?<!\w)` and
 *         `(?!\w)` so that `deadbeefXYZ`, `#deadbeef`, and `DEADBEEF` (uppercase) do
 *         NOT match. The upper-case exclusion matters: CSS `#DEADBEEF` is never
 *         matched because the regex uses the `i` flag but the prefix alternative
 *         requires being at a word boundary where a letter or digit does not precede.
 *         NOTE: `#deadbeef` (CSS color with `#` prefix) is excluded because `#` is
 *         not a word char but IS immediately before the hex string — however `(?<!\w)`
 *         allows `#` (not a word char). We therefore also exclude when preceded by `#`.
 *   4. Non-minsky https?:// URLs — same trailing-punct discipline as minsky://.
 *
 * TRAILING PUNCTUATION STRIPPING (minsky:// and https?://):
 *   The character class `[^\s<>",).\];]` matches valid URI chars excluding prose-punct.
 *   Within the run, `[.,)\];]` is allowed ONLY when followed by a non-punct non-space
 *   char (meaning it's mid-URI, not trailing). This is implemented with the alternation:
 *     `(?:[^\s<>",).\];]|[.,)\];](?=[^\s<>",).\];]))`
 *   which in greedy mode stops before any trailing sequence of `.`, `,`, `)`, `]`, `;`.
 *
 * Groups:
 *   [1] minsky:// URI (trailing prose punctuation excluded)
 *   [2] mt# task id
 *   [3] UUID / 8-char-hex-prefix candidate (bounded; no CSS colors, no word-embedded hex)
 *   [4] https?:// URL (always plain text; trailing prose punctuation excluded)
 */
const _URL_BODY = "(?:[^\\s<>\",.);\\]]|[,.);\\]](?=[^\\s<>\",.);\\]]))";
const TOKEN_RE = new RegExp(
  // Group 1: minsky:// URI (trailing-punct stripped)
  `(minsky:\\/\\/${_URL_BODY}+)` +
    // Group 2: mt# task id (bounded — no leading word char, no trailing word char)
    `|((?<![a-zA-Z0-9_])mt#\\d+\\b)` +
    // Group 3: full UUID first (takes priority via order), then bounded 8-char hex prefix
    // The 8-char prefix is excluded when immediately preceded by '#' (CSS color) or any
    // word char. `(?<![\\w#])` covers both.
    `|(\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b` +
    `|(?<![\\w#])[0-9a-f]{8}(?!\\w))` +
    // Group 4: https?:// URL (trailing-punct stripped, always plain text)
    `|(https?:\\/\\/${_URL_BODY}+)`,
  "gi"
);

/**
 * Tokenize `text` into an array of React nodes, converting entity references
 * to in-SPA `<Link>` elements.
 *
 * @param text      The plain-text string to tokenize.
 * @param index     The known-entity id-set (from `buildEntityIndex`).
 * @param linkProps Optional extra props to apply to every generated `<Link>`.
 */
export function linkifyText(
  text: string,
  index: EntityIndex,
  linkProps?: Record<string, unknown>
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset the lastIndex since TOKEN_RE has the `g` flag.
  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [fullMatch, minskyUri, taskId, uuidCandidate, httpsUrl] = match;
    const matchStart = match.index;

    // Append any plain text before this match.
    if (matchStart > lastIndex) {
      nodes.push(text.slice(lastIndex, matchStart));
    }
    lastIndex = matchStart + fullMatch.length;

    // --- (a) Explicit minsky:// URI ---
    if (minskyUri) {
      const path = parseMinskyUri(minskyUri)
        ? // parseMinskyUri succeeded; derive the path via the codec
          (() => {
            const parsed = parseMinskyUri(minskyUri)!;
            return entityToPath(parsed.type, parsed.id);
          })()
        : null;

      if (path) {
        nodes.push(
          createElement(
            Link,
            {
              key: `link-${matchStart}`,
              to: path,
              className: "text-primary underline-offset-2 hover:underline",
              ...linkProps,
            },
            minskyUri
          )
        );
      } else {
        // Malformed minsky URI (unknown type, etc.) → plain text
        nodes.push(minskyUri);
      }
      continue;
    }

    // --- (b) Bare task id: mt#NNNN — id-set GATED ---
    // Bare `mt#NNNN` is linked ONLY when the id is present in the entity index.
    // A well-formed mt# that is NOT a known task → plain text (zero false positives).
    // The id-set is comprehensive (useEntityIndex fetches /api/tasks?all=true so
    // DONE/CLOSED tasks are included) — see mt#2518 R4.
    if (taskId) {
      const resolved = resolveEntityId(taskId, index);
      if (resolved) {
        const path = entityToPath(resolved.type, resolved.id);
        nodes.push(
          createElement(
            Link,
            {
              key: `link-${matchStart}`,
              to: path,
              className: "font-mono text-primary underline-offset-2 hover:underline",
              ...linkProps,
            },
            taskId
          )
        );
      } else {
        // mt# not in id-set → plain text
        nodes.push(taskId);
      }
      continue;
    }

    // --- (c) UUID / hex-prefix candidate ---
    if (uuidCandidate) {
      const resolved = resolveEntityId(uuidCandidate, index);
      if (resolved) {
        const path = entityToPath(resolved.type, resolved.id);
        nodes.push(
          createElement(
            Link,
            {
              key: `link-${matchStart}`,
              to: path,
              className: "font-mono text-primary underline-offset-2 hover:underline",
              ...linkProps,
            },
            uuidCandidate
          )
        );
      } else {
        // UUID not in id-set → plain text
        nodes.push(uuidCandidate);
      }
      continue;
    }

    // --- https:// URL (always plain text) ---
    if (httpsUrl) {
      nodes.push(httpsUrl);
      continue;
    }

    // Fallback: should not be reached, but append plain text to be safe.
    nodes.push(fullMatch);
  }

  // Append any remaining text after the last match.
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// React component wrapper (optional convenience)
// ---------------------------------------------------------------------------

/**
 * Renders `text` with entity references converted to in-SPA links.
 *
 * Usage: replace `{element.text}` in a `<p>` with `<LinkifiedText text={element.text} index={entityIndex} />`.
 */
export function LinkifiedText({
  text,
  index,
}: {
  text: string;
  index: EntityIndex;
}): React.ReactElement {
  const nodes = linkifyText(text, index);
  // Use Fragment so the caller's <p> stays as the wrapper.
  return createElement(Fragment, null, ...nodes);
}
