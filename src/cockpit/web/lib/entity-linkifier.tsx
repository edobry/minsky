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
 * @see mt#2769 — conversation (harness agentSessionId) linkification
 */
import { createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Root, Element, ElementContent } from "hast";
import { parseShortId } from "@minsky/domain/utils/short-id";
import { parseMinskyUri, entityToPath, type RoutableEntityType } from "./entity-codec";

// ---------------------------------------------------------------------------
// Id-set index
// ---------------------------------------------------------------------------

/**
 * The numeric short-id prefixes (ADR-029) that name a routable entity, mapped
 * to their type. These are the prefixes minted today — `mem`
 * (`memory-service.ts`), `ask` (`ask/repository.ts`), and `ws`
 * (`SESSION_SHORT_ID_PREFIX`, `drizzle-session-repository.ts`). A
 * `<prefix>#<n>` token whose prefix is NOT in this map stays plain text, so
 * ordinary prose like `issue#42` or `chapter#3` is never linkified.
 *
 * Tasks are deliberately absent: `mt#NNNN` IS a task's primary key, so it is
 * handled by the `taskId` token class above, not as a short-id alias.
 */
const SHORT_ID_PREFIX_TO_TYPE: Record<string, RoutableEntityType> = {
  mem: "memory",
  ask: "ask",
  ws: "session",
};

/**
 * What an index key resolves to: the entity's type, plus its CANONICAL id.
 *
 * `id` is what the link target is built from, and it is NOT always the key.
 * For a canonical key (a uuid, an `mt#N`, a PR number) it is the key itself.
 * For a short-id alias key (`mem#728`) it is the entity's UUID — so a
 * short-id reference links to `/memory/<uuid>`, exactly like a uuid
 * reference to the same entity, and carries the same `data-entity-id`
 * (mt#3174). Keeping the UUID canonical in every emitted path is the same
 * discipline ADR-029 applies to `minsky://` targets; the short id is a
 * display form for the reader, never an address.
 */
export interface EntityIndexEntry {
  type: RoutableEntityType;
  id: string;
}

/**
 * A map from a REFERENCE STRING to the entity it names. Keys are every form a
 * reference can take (uuid, `mt#N`, PR number, `mem#N`/`ask#N`/`ws#N`);
 * values carry the canonical id those forms all resolve to.
 *
 * Built from the data CommandPalette already fetches
 * (tasks/sessions/asks/memories/changesets/conversations).
 */
export type EntityIndex = Map<string, EntityIndexEntry>;

/** A short id paired with the canonical uuid it resolves to. */
export interface ShortIdAlias {
  shortId: string;
  id: string;
}

/**
 * Build an EntityIndex from flat lists of ids per type.
 *
 * Pass the same data CommandPalette uses — no new queries needed.
 *
 * Short ids are registered as ADDITIONAL keys pointing at their entity's
 * canonical uuid, so `mem#728` and the uuid produce the identical link target
 * and the identical `data-entity-id`. They are aliases in the id-set, not a
 * second address space.
 */
export function buildEntityIndex(opts: {
  taskIds: string[];
  sessionIds: string[];
  askIds: string[];
  memoryIds: string[];
  /** PR numbers (as strings) for open/draft changesets. Gates `PR #N` linkification. */
  changesetIds?: string[];
  /**
   * Harness agentSessionIds (conversation ids — distinct id-space from `sessionIds`
   * above, which are Minsky workspace sessionIds). Gates conversation-id
   * linkification to `/conversation/:id` (mt#2769).
   */
  conversationIds?: string[];
  /** `mem#N` → uuid aliases (mt#3259). Additive — never replaces the uuid keys. */
  memoryShortIds?: ShortIdAlias[];
  /** `ask#N` → uuid aliases (mt#3259). */
  askShortIds?: ShortIdAlias[];
  /** `ws#N` → workspace-sessionId aliases (mt#3259). */
  sessionShortIds?: ShortIdAlias[];
}): EntityIndex {
  const index: EntityIndex = new Map();
  const addCanonical = (ids: string[], type: RoutableEntityType): void => {
    for (const id of ids) index.set(id, { type, id });
  };
  const addAliases = (aliases: ShortIdAlias[], type: RoutableEntityType): void => {
    // Skip an alias with no canonical target: a key whose `id` we don't know
    // could only produce a link to the short id itself, which is the exact
    // non-canonical address this indirection exists to avoid.
    for (const a of aliases) {
      if (a.shortId && a.id) index.set(a.shortId, { type, id: a.id });
    }
  };

  addCanonical(opts.taskIds, "task");
  addCanonical(opts.sessionIds, "session");
  addCanonical(opts.askIds, "ask");
  addCanonical(opts.memoryIds, "memory");
  addCanonical(opts.changesetIds ?? [], "changeset");
  addCanonical(opts.conversationIds ?? [], "conversation");
  addAliases(opts.memoryShortIds ?? [], "memory");
  addAliases(opts.askShortIds ?? [], "ask");
  addAliases(opts.sessionShortIds ?? [], "session");
  return index;
}

/**
 * Resolve a candidate token against the EntityIndex.
 *
 * Supports:
 *   - Exact match (the token is a known reference form)
 *   - Unique-prefix match (the token is a prefix of exactly ONE key)
 *
 * Returns `{type, id}` where `id` is the CANONICAL id (never the alias key),
 * or null on no-match / ambiguous.
 */
function resolveEntityId(token: string, index: EntityIndex): EntityIndexEntry | null {
  // Exact match wins immediately.
  const exact = index.get(token);
  if (exact !== undefined) return exact;

  // Prefix match — the token must be a prefix of exactly one known key.
  // Only meaningful for UUID-shaped tokens (≥8 hex chars) to avoid false
  // positives on very short prefixes.
  if (token.length < 8) return null;

  const matches: EntityIndexEntry[] = [];
  for (const [key, entry] of index) {
    if (key.startsWith(token)) {
      matches.push(entry);
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
 * Named groups (accessed via `match.groups`, NOT positional indices — mt#2536 R1):
 *   minskyUri — minsky:// URI (trailing prose punctuation excluded)
 *   taskId    — mt# task id
 *   uuid      — UUID / 8-char-hex-prefix candidate (bounded; no CSS colors, no word-embedded hex)
 *   httpsUrl  — https?:// URL (always plain text; trailing prose punctuation excluded).
 *               Ordered BEFORE prRef so a URL containing `PR#N` is consumed whole.
 *   prRef     — PR/changeset ref full match (e.g. "PR #1234")
 *   prNumber  — the digit string nested inside prRef (e.g. "1234")
 */
const _URL_BODY = '(?:[^\\s<>",.);\\]]|[,.);\\]](?=[^\\s<>",.);\\]]))';
const TOKEN_RE = new RegExp(
  // NAMED groups (accessed via match.groups — positional indices are NOT relied on).
  // minskyUri: minsky:// URI (trailing-punct stripped)
  `(?<minskyUri>minsky:\\/\\/${_URL_BODY}+)` +
    // taskId: mt# task id (bounded — no leading word char, no trailing word char)
    `|(?<taskId>(?<![a-zA-Z0-9_])mt#\\d+\\b)` +
    // uuid: full UUID first (takes priority via order), then bounded 8-char hex prefix.
    // The 8-char prefix is excluded when immediately preceded by '#' (CSS color) or any
    // word char. `(?<![\\w#])` covers both.
    `|(?<uuid>\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b` +
    `|(?<![\\w#])[0-9a-f]{8}(?!\\w))` +
    // httpsUrl: https?:// URL (trailing-punct stripped, always plain text). Declared
    // BEFORE prRef so a URL containing `PR#N` (e.g. https://x.tld/PR#1234) is consumed
    // whole as a URL and never mis-split into a changeset ref (mt#2536 R1).
    `|(?<httpsUrl>https?:\\/\\/${_URL_BODY}+)` +
    // prRef: PR/changeset ref — "PR #N" or "PR#N"; bounded. prNumber: the nested digits.
    `|(?<prRef>(?<!\\w)PR\\s*#(?<prNumber>\\d+)\\b)` +
    // shortId: a generic `<prefix>#<n>` short-id CANDIDATE (mt#3259). Declared LAST on
    // purpose: `mt#N` must be consumed by `taskId` and `PR#N` by `prRef` (both of which
    // this pattern would otherwise match), so ordering — not a negative lookahead — is
    // what keeps those two classes on their existing paths. The prefix is validated by
    // `parseShortId` + SHORT_ID_PREFIX_TO_TYPE at handling time, not here, so this
    // regex stays a cheap candidate-finder and the SHAPE authority stays in the domain.
    `|(?<shortId>(?<![a-zA-Z0-9_])[a-zA-Z][a-zA-Z0-9]*#\\d+\\b)`,
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
    // Named-group access (NOT positional indices) — robust to future group
    // reordering and self-documenting (mt#2536 R1: reviewer flagged positional
    // brittleness in the prior `match[0..6]` destructuring).
    const fullMatch = match[0];
    const { minskyUri, taskId, uuid: uuidCandidate, httpsUrl, prRef, prNumber, shortId } = match.groups ?? {};
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

    // --- (f) Numeric short id: `mem#728` / `ask#3346` / `ws#42` — id-set GATED ---
    // Two independent gates, both required: the prefix must name a routable entity
    // type, AND the token must be in the id-set. `parseShortId` (the same domain
    // helper the MINTING side uses) is the shape authority — it rejects `mem#0`,
    // `mem#5abc`, and anything else not exactly `<prefix>#<positive-int>` — and it
    // normalizes the prefix, so `MEM#728` resolves identically to `mem#728`.
    if (shortId) {
      const parsed = parseShortId(shortId);
      const type = parsed ? SHORT_ID_PREFIX_TO_TYPE[parsed.prefix] : undefined;
      if (type) {
        const resolved = resolveEntityId(`${parsed!.prefix}#${parsed!.n}`, index);
        if (resolved) {
          tokens.push({
            kind: "link",
            text: shortId,
            to: entityToPath(resolved.type, resolved.id),
            mono: true,
          });
          continue;
        }
      }
      pushText(shortId); // unknown prefix, malformed, or not in the id-set → plain text
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

/**
 * Resolve the `(type, id)` an entity-token's `to` path was built from, so
 * `makeAnchor` can carry that identity forward as `data-` attributes without
 * re-parsing the href (mt#3174). `to` is always produced by `entityToPath`
 * (see `resolveEntityId`/`parseMinskyUri` above), so this is the exact
 * inverse of that codec — never a guess from the path string.
 *
 * EXPORTED (mt#3175) so payload-leaf renderers (`JsonView`) route tokens
 * through `<EntityRef>` using this same inverse rather than re-deriving their
 * own segment map — a second copy would drift silently the next time the route
 * registry changes.
 */
export function tokenEntity(tok: Extract<EntityToken, { kind: "link" }>): {
  type: RoutableEntityType;
  id: string;
} | null {
  return pathToEntity(tok.to);
}

/**
 * The inverse itself, over a bare path (mt#4351).
 *
 * Split out of {@link tokenEntity} so a caller holding an href rather than a
 * token can ask the same question — specifically `<Prose>`'s `a` override,
 * which must decide whether a markdown-AUTHORED link (`[label](/memory/<uuid>)`)
 * names an entity. Hand-rolling a second segment map there is the drift this
 * function's own docblock warns about; there is now exactly one.
 *
 * Returns null for any path that is not an entity route, so a link to
 * `/activity` or `/settings` is left as an ordinary in-SPA link.
 *
 * A path carrying a QUERY or FRAGMENT is also null (PR #3181 R1/R2/R3).
 * `/memory/<uuid>?tab=details` addresses something within or about the entity,
 * not the entity itself — and the caller's fallback, a `<Link to={href}>`,
 * is the only rendering that preserves it. Resolving it here would be worse
 * than not resolving it: the old `(.+)` capture swallowed `?tab=details` INTO
 * the id, and `entityToPath` then re-encoded the whole thing into
 * `/memory/<uuid>%3Ftab%3Ddetails` — a corrupt id, silently, with the query
 * gone from both the peek and the Cmd-click. Rejecting is what lets the caller
 * keep the href verbatim.
 *
 * `tokenEntity`'s inputs are built by `entityToPath` and never carry either,
 * so this costs the tokenizer nothing.
 */
export function pathToEntity(path: string): {
  type: RoutableEntityType;
  id: string;
} | null {
  if (path.includes("?") || path.includes("#")) return null;
  // `/<segment>/<encodedId>` — first path segment maps 1:1 to a
  // RoutableEntityType (entityToPath's switch, inverted).
  const match =
    /^\/(tasks|ask|memory|agents|changeset|conversation|interceptors)\/(.+)$/.exec(path);
  if (!match) return null;
  const [, segment, encodedId] = match;
  const SEGMENT_TO_TYPE: Record<string, RoutableEntityType> = {
    tasks: "task",
    ask: "ask",
    memory: "memory",
    agents: "session",
    changeset: "changeset",
    conversation: "conversation",
    // mt#4010. Agents do not EMIT this type in prose (cockpit-deeplinks.mdc
    // keeps the emit set at five), but the codec accepts it, so a
    // `minsky://interceptor/<guardName>` URI reaching Prose produces a link
    // token here. Omitting the segment would render an anchor that navigates
    // correctly but silently loses its entity identity — no hover card, no
    // EntityRef treatment. An inverse of `entityToPath` that is missing a case
    // is a latent bug regardless of who emits it.
    interceptors: "interceptor",
  };
  const type = SEGMENT_TO_TYPE[segment as string];
  if (!type) return null;
  try {
    return { type, id: decodeURIComponent(encodedId as string) };
  } catch {
    return null;
  }
}

function makeAnchor(tok: Extract<EntityToken, { kind: "link" }>): Element {
  const entity = tokenEntity(tok);
  return {
    type: "element",
    tagName: "a",
    properties: {
      href: tok.to,
      className: tok.mono
        ? ["font-mono", "text-primary", "underline-offset-2", "hover:underline"]
        : ["text-primary", "underline-offset-2", "hover:underline"],
      // Entity identity carried alongside href (mt#3174) — <Prose>'s `a`
      // override reads these to render the hover-card badge treatment
      // without re-parsing the href back into an entity. Additive only:
      // any consumer that ignores these two attributes sees the exact same
      // anchor as before this change.
      ...(entity ? { "data-entity-type": entity.type, "data-entity-id": entity.id } : {}),
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