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
 *   - PR/changeset refs (`PR #N`) are linkified when N is in the known changeset
 *     id-set (mt#2536); bare `#N` (no `PR` prefix) stays plain text.
 *
 * The tokenizer is a pure `string → ReactNode[]` function — no remark/rehype,
 * no markdown, just regex-based tokenization of the plain text.
 *
 * @see entity-codec.ts — the (type, id) ↔ minsky:// URI ↔ path codec
 * @see mt#2518 — this task
 * @see mt#2536 — PR/changeset linkification
 */
import { createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Root, Element, ElementContent } from "hast";
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
  /** PR numbers (as strings) for open/draft changesets. Gates `PR #N` linkification. */
  changesetIds?: string[];
}): EntityIndex {
  const index: EntityIndex = new Map();
  for (const id of opts.taskIds) index.set(id, "task");
  for (const id of opts.sessionIds) index.set(id, "session");
  for (const id of opts.askIds) index.set(id, "ask");
  for (const id of opts.memoryIds) index.set(id, "memory");
  for (const id of opts.changesetIds ?? []) index.set(id, "changeset");
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
 *   5. PR/changeset refs — `PR #N` (with optional space) where N is one or more digits.
 *      Bounded: `(?<!\w)` before PR so "AAPR#1" is not matched; `\b` after digits.
 *      Bare `#N` (no PR prefix) is NEVER matched. Linkified only when N is in the
 *      changeset id-set (id-set gated, zero false positives). (mt#2536)
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
 *   [5] PR/changeset ref full match (e.g. "PR #1234"); extract number via /\d+$/.exec()
 */
const _URL_BODY = '(?:[^\\s<>",.);\\]]|[,.);\\]](?=[^\\s<>",.);\\]]))';
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
    `|(https?:\\/\\/${_URL_BODY}+)` +
    // Group 5: PR/changeset ref — "PR #N" or "PR#N"; bounded, digits-only number
    `|((?<!\\w)PR\\s*#(\\d+)\\b)`,
  "gi"
);

// ---------------------------------------------------------------------------
// Structured tokenizer (the reusable core)
// ---------------------------------------------------------------------------

/**
 * A token produced by `tokenizeEntities`: either a run of plain text or a
 * resolved entity link (the FULL SPA path is already computed).
 *
 * `mono: true` means the link should render in a monospace font (task ids and
 * UUID-shaped refs); `mono: false` is for `minsky://` URIs.
 */
export type EntityToken =
  | { kind: "text"; value: string }
  | { kind: "link"; text: string; to: string; mono: boolean };

const LINK_CLASS = "text-primary underline-offset-2 hover:underline";
const LINK_CLASS_MONO = "font-mono text-primary underline-offset-2 hover:underline";

/**
 * Tokenize `text` into a flat array of {@link EntityToken}s. This is the pure,
 * framework-agnostic core shared by:
 *   - {@link linkifyText} — builds React `<Link>` nodes (flat plain-text callers)
 *   - {@link rehypeEntityLinks} — splits hast text nodes inside a Markdown tree
 *
 * Recognizes the same four token classes as the original tokenizer (in priority
 * order): `minsky://` URIs, id-set-gated `mt#NNNN`, id-set-gated UUID/hex
 * prefixes, and `https?://` URLs (always plain text). Non-matching / unresolved
 * tokens stay plain text (zero false positives — see the module header).
 */
export function tokenizeEntities(text: string, index: EntityIndex): EntityToken[] {
  const tokens: EntityToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset the lastIndex since TOKEN_RE has the `g` flag.
  TOKEN_RE.lastIndex = 0;

  // Push a plain-text segment (skip empties). Segments are kept distinct (not
  // coalesced) so this preserves linkifyText's original node structure — each
  // run of plain text between/around matches is its own node.
  const pushText = (value: string): void => {
    if (value) tokens.push({ kind: "text", value });
  };

  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [fullMatch, minskyUri, taskId, uuidCandidate, httpsUrl, prRef, prNumber] = match;
    const matchStart = match.index;

    if (matchStart > lastIndex) pushText(text.slice(lastIndex, matchStart));
    lastIndex = matchStart + fullMatch.length;

    // --- (a) Explicit minsky:// URI ---
    if (minskyUri) {
      const parsed = parseMinskyUri(minskyUri);
      const path = parsed ? entityToPath(parsed.type, parsed.id) : null;
      if (path) tokens.push({ kind: "link", text: minskyUri, to: path, mono: false });
      else pushText(minskyUri); // malformed URI → plain text
      continue;
    }

    // --- (b) Bare task id: mt#NNNN — id-set GATED (zero false positives) ---
    if (taskId) {
      const resolved = resolveEntityId(taskId, index);
      if (resolved) {
        tokens.push({
          kind: "link",
          text: taskId,
          to: entityToPath(resolved.type, resolved.id),
          mono: true,
        });
      } else pushText(taskId); // mt# not in id-set → plain text
      continue;
    }

    // --- (c) UUID / hex-prefix candidate — id-set GATED ---
    if (uuidCandidate) {
      const resolved = resolveEntityId(uuidCandidate, index);
      if (resolved) {
        tokens.push({
          kind: "link",
          text: uuidCandidate,
          to: entityToPath(resolved.type, resolved.id),
          mono: true,
        });
      } else pushText(uuidCandidate); // UUID not in id-set → plain text
      continue;
    }

    // --- https:// URL (always plain text) ---
    if (httpsUrl) {
      pushText(httpsUrl);
      continue;
    }

    // --- (e) PR/changeset ref: "PR #N" — id-set GATED (zero false positives) ---
    // prRef is the full match (e.g. "PR #1234"), prNumber is the digit string ("1234").
    if (prRef && prNumber) {
      const resolved = resolveEntityId(prNumber, index);
      if (resolved && resolved.type === "changeset") {
        tokens.push({
          kind: "link",
          text: prRef,
          to: entityToPath("changeset", resolved.id),
          mono: true,
        });
      } else pushText(prRef); // PR number not in changeset id-set → plain text
      continue;
    }

    // Fallback: should not be reached, but append plain text to be safe.
    pushText(fullMatch);
  }

  if (lastIndex < text.length) pushText(text.slice(lastIndex));

  return tokens;
}

/**
 * Tokenize `text` into an array of React nodes, converting entity references
 * to in-SPA `<Link>` elements. Thin wrapper over {@link tokenizeEntities}.
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
  return tokenizeEntities(text, index).map((tok, i) => {
    if (tok.kind === "text") return tok.value;
    return createElement(
      Link,
      {
        key: `link-${i}`,
        to: tok.to,
        className: tok.mono ? LINK_CLASS_MONO : LINK_CLASS,
        ...linkProps,
      },
      tok.text
    );
  });
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

// ---------------------------------------------------------------------------
// rehype plugin — entity-linkify inside a Markdown (hast) tree (mt#2550)
// ---------------------------------------------------------------------------

/** Tags whose text content must NOT be linkified: code spans, code blocks,
 *  and existing anchors (markdown links / gfm autolinks). */
const SKIP_TAGS = new Set(["code", "pre", "a"]);

export interface RehypeEntityLinksOptions {
  /** Known-entity id-set; bare refs link only when present here. */
  index: EntityIndex;
}

/**
 * A rehype plugin that walks the Markdown-rendered hast tree and converts
 * entity references found in leaf TEXT nodes into anchor (`<a href="/...">`)
 * nodes, reusing {@link tokenizeEntities}. Code spans, code blocks, and
 * existing anchors are skipped (their text is left verbatim).
 *
 * This is the composition contract for `<Prose>`: Markdown is parsed FIRST
 * (so it sees real structure, not syntax characters), THEN linkification runs
 * over the resulting text leaves. The emitted anchors carry the SPA path in
 * `href` (always `/`-prefixed via `entityToPath`); `<Prose>`'s `a` component
 * override renders those as react-router `<Link>`s.
 */
export function rehypeEntityLinks(options: RehypeEntityLinksOptions) {
  return (tree: Root): void => {
    const index = options?.index;
    if (!index || index.size === 0) return;
    visitEntityNodes(tree, index);
  };
}

function makeAnchor(tok: Extract<EntityToken, { kind: "link" }>): Element {
  return {
    type: "element",
    tagName: "a",
    properties: {
      href: tok.to,
      className: tok.mono
        ? ["font-mono", "text-primary", "underline-offset-2", "hover:underline"]
        : ["text-primary", "underline-offset-2", "hover:underline"],
    },
    children: [{ type: "text", value: tok.text }],
  };
}

function visitEntityNodes(node: Root | Element, index: EntityIndex): void {
  const out: ElementContent[] = [];
  for (const child of node.children as ElementContent[]) {
    if (child.type === "text") {
      const tokens = tokenizeEntities(child.value, index);
      // No entity links in this text node → keep it untouched (the common case
      // for ordinary prose, incl. text with bare https URLs / unresolved refs).
      if (!tokens.some((t) => t.kind === "link")) {
        out.push(child);
        continue;
      }
      for (const tok of tokens) {
        if (tok.kind === "text") out.push({ type: "text", value: tok.value });
        else out.push(makeAnchor(tok));
      }
      continue;
    }
    if (child.type === "element") {
      if (!SKIP_TAGS.has(child.tagName)) visitEntityNodes(child, index);
      out.push(child);
      continue;
    }
    out.push(child);
  }
  node.children = out as typeof node.children;
}
