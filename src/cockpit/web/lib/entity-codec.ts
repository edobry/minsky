/**
 * Entity codec — single source of truth for `(type, id) ↔ minsky:// URI ↔ cockpit path`.
 *
 * This module is the forward inverse of `matchEntityRoute` (tabs.tsx). Three consumers:
 *   1. The transcript linkifier (entity-linkifier.tsx) — renders minsky:// links + bare refs
 *   2. CommandPalette.handleSelect — entity→path navigation (refactored off its inline switch)
 *   3. Surface A emit helper (mt#2519) — produces minsky:// URIs for agent-emitted refs
 *   4. Tray scheme handler's frontend nav (mt#2528) — resolves minsky:// to cockpit path
 *
 * Route conventions (mt#2398 / mt#2536 / mt#2769):
 *   task         → /tasks/:id        (id is percent-encoded; # → %23)
 *   ask          → /ask/:id
 *   memory       → /memory/:id
 *   session      → /agents/:id       (NOTE: /agents/, not /session/)
 *   changeset    → /changeset/:id    (changeset id == PR number; mt#2535 added the route)
 *   conversation → /conversation/:id (harness agentSessionId; mt#2769)
 *   interceptor  → /interceptors/:name (id is the `guardName`; mt#4010)
 *
 * ACCEPT vs EMIT (mt#3800, extended mt#4010). `parseMinskyUri` accepts SEVEN types — the five
 * agents emit, plus `conversation` (so `minsky://conversation/<agentSessionId>` resolves, which is
 * what lets a terminal-side command (`/cockpit`) hand the tray a live conversation) and
 * `interceptor` (mt#4010's catalog detail route). What agents deliberately EMIT in terminal output
 * is a narrower, separate question governed by `cockpit-deeplinks.mdc §The five entity types`; do
 * not read either list as the other's contract. `interceptor` is deliberately on the ACCEPT side
 * only: it makes a catalog row addressable and linkable from within the cockpit, and adding a
 * sixth emit-type is a separate decision this task does not take.
 *
 * From mt#2769 until mt#3800 this header attributed the five-type restriction to an "ADR-022
 * stage-1 constraint." It was not one: ADR-022 contains no mention of `minsky://`, URIs, or a
 * deeplink type table — its stage-1 text scopes to vocabulary adoption in new code and to leaving
 * `session_*` tools/params/DB-columns/paths untouched, and stage 2 to the `session_*` →
 * `workspace_*` rename. Adding `conversation` renames nothing and leaves `session` meaning the
 * workspace id, so it collides with neither stage.
 *
 * @see tabs.tsx `matchEntityRoute` — the reverse codec (path → entity)
 * @see mt#2517 — parent umbrella
 * @see mt#2518 — this task
 * @see mt#2536 — PR/changeset linkification (this task)
 * @see mt#2769 — added "conversation" (web-route only)
 * @see mt#4724 — the changeset id's two forms (bare / `owner/repo#N`)
 */
import { isChangesetId } from "@minsky/shared/changeset-id";

/**
 * Entity types that have a routable cockpit detail page.
 *
 * This ARRAY is the single runtime source of truth and `RoutableEntityType` is
 * derived from it, rather than the two being maintained side by side (mt#3694).
 * Two consumers need to ENUMERATE the set at runtime, not just narrow against
 * it: `parseMinskyUri`'s validation below, which previously kept its own
 * hand-written copy that could drift, and the peek layer's coverage test, which
 * asserts every routable type renders a body — so adding a type here is a
 * failing test until that type has one, instead of a silent gap.
 */
export const ROUTABLE_ENTITY_TYPES = [
  "task",
  "ask",
  "session",
  "memory",
  "changeset",
  "conversation",
  "interceptor",
] as const;

/** Entity types that have a routable cockpit detail page. */
export type RoutableEntityType = (typeof ROUTABLE_ENTITY_TYPES)[number];

/**
 * Convert a `(type, id)` pair to the cockpit SPA path.
 *
 * The `#` in task ids (e.g. `mt#2370`) is percent-encoded as `%23`
 * so the browser doesn't treat it as a URL fragment.
 *
 * Session detail pages live at `/agents/:id` (the workspace session id-space),
 * matching `matchEntityRoute`'s `/agents/` branch.
 */
export function entityToPath(type: RoutableEntityType, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case "task":
      return `/tasks/${encoded}`;
    case "ask":
      return `/ask/${encoded}`;
    case "memory":
      return `/memory/${encoded}`;
    case "session":
      return `/agents/${encoded}`;
    case "changeset":
      return `/changeset/${encoded}`;
    case "conversation":
      return `/conversation/${encoded}`;
    case "interceptor":
      // Plural route noun, singular type noun — the catalog lives at
      // `/interceptors` (ask#7119) and a detail page is a row within it.
      return `/interceptors/${encoded}`;
  }
}

/**
 * Convert a `(type, id)` pair to a `minsky://` URI.
 *
 * The canonical form is `minsky://<type>/<id>` where the id is percent-encoded.
 * The type is carried in the URI so a link resolves even when the id isn't in
 * the loaded id-set (i.e. the link is robust to id-set staleness).
 *
 * Example: `entityToMinskyUri("task", "mt#2370")` → `"minsky://task/mt%232370"`
 */
export function entityToMinskyUri(type: RoutableEntityType, id: string): string {
  return `minsky://${type}/${encodeURIComponent(id)}`;
}

/**
 * Trailing prose-punctuation a terminal's URL auto-detection commonly captures around a
 * `minsky://` URI — markdown/bracket closers (`)` `]` `>`), clause separators (`.` `,` `;` `:`),
 * and sentence terminators (`!` `?`).
 *
 * Without stripping these, `[mt#2370](minsky://task/mt%232370)` delivers a trailing `)` that
 * decodes INTO the id and the lookup fails ("Task mt#2370) not found", mt#2549); `:` was the same
 * defect, found in PR #2695 R1 on "see minsky://task/mt%232370: it explains why". The in-cockpit
 * transcript linkifier (entity-linkifier.tsx) already excludes these at match time; this mirrors
 * that for the EXTERNAL deep-link path (mt#2528), which receives raw OS-delivered URLs.
 *
 * Safe because every id form is a `#`-suffixed task id, a uuid, or a digit string — none can END
 * in any of these. Applied twice in `parseMinskyUri` (before and after percent-decoding, since
 * `%3A` etc. are invisible to the first pass); a single constant is what keeps the two passes
 * from drifting apart.
 */
const TRAILING_PROSE_PUNCTUATION = /[.,;:!?)\]>]+$/;

/**
 * Parse a `minsky://` URI back to `{type, id}`.
 *
 * Returns `null` when the input is not a valid `minsky://` URI or the type is not one of the seven
 * accepted URI types (task/ask/session/memory/changeset/conversation/interceptor). `session` keeps
 * meaning the WORKSPACE id here, unrelated to `conversation` — see the module header's
 * accept-vs-emit note.
 *
 * Example: `parseMinskyUri("minsky://task/mt%232370")` → `{type: "task", id: "mt#2370"}`
 */
export function parseMinskyUri(uri: string): { type: RoutableEntityType; id: string } | null {
  // Must start with "minsky://"
  if (!uri.startsWith("minsky://")) return null;

  const withoutScheme = uri.slice("minsky://".length);
  // Must have at least one slash separating type and id
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) return null;

  const rawType = withoutScheme.slice(0, slashIdx);
  // Pass 1 of 2: strip the punctuation a terminal captured verbatim.
  const rawId = withoutScheme.slice(slashIdx + 1).replace(TRAILING_PROSE_PUNCTUATION, "");

  // Validate type against the shared runtime list (mt#3694) rather than a
  // second hand-written copy, which is how this check could silently fall
  // behind the type union it is meant to enforce.
  if (!(ROUTABLE_ENTITY_TYPES as readonly string[]).includes(rawType)) return null;

  // Id must not be empty
  if (!rawId) return null;

  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }

  // Pass 2 of 2: the same punctuation, arriving PERCENT-ENCODED (`%29` → `)`,
  // `%3A` → `:`, …), which pass 1 could not see. Re-check empty in case the id
  // was entirely (encoded) punctuation.
  id = id.replace(TRAILING_PROSE_PUNCTUATION, "");
  if (!id) return null;

  // `changeset` ids are validated so a malformed `minsky://changeset/abc` does
  // not parse and route to a nonexistent `/changeset/abc` (mt#2536 R1); other
  // entity types keep their free-form id shape.
  //
  // Two forms are accepted (mt#4724). A BARE PR number — what every
  // already-emitted link carries, resolved server-side against the default
  // project, which is what it has always meant. And a QUALIFIED
  // `owner/repo#N`, which names its own repository, because a PR number is
  // unique only per-repo: `changeset` is the one routable entity type without
  // a global id-space. The qualified form survives this path unchanged —
  // `entityToMinskyUri` percent-encodes `/` and `#`, so the decode above
  // returns it intact.
  if (rawType === "changeset" && !isChangesetId(id)) return null;

  return { type: rawType as RoutableEntityType, id };
}

/**
 * Resolve a `minsky://` URI directly to the cockpit SPA path.
 *
 * Convenience wrapper: `parseMinskyUri` + `entityToPath`. Returns `null` on
 * parse failure so callers can fall back to plain text.
 */
export function minskyUriToPath(uri: string): string | null {
  const parsed = parseMinskyUri(uri);
  if (!parsed) return null;
  return entityToPath(parsed.type, parsed.id);
}
