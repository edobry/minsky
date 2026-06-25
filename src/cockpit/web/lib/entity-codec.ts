/**
 * Entity codec — single source of truth for `(type, id) ↔ minsky:// URI ↔ cockpit path`.
 *
 * This module is the forward inverse of `matchEntityRoute` (tabs.tsx). Three consumers:
 *   1. The transcript linkifier (entity-linkifier.tsx) — renders minsky:// links + bare refs
 *   2. CommandPalette.handleSelect — entity→path navigation (refactored off its inline switch)
 *   3. Surface A emit helper (mt#2519) — produces minsky:// URIs for agent-emitted refs
 *   4. Tray scheme handler's frontend nav (mt#2528) — resolves minsky:// to cockpit path
 *
 * Route conventions (mt#2398 / mt#2536):
 *   task      → /tasks/:id       (id is percent-encoded; # → %23)
 *   ask       → /ask/:id
 *   memory    → /memory/:id
 *   session   → /agents/:id      (NOTE: /agents/, not /session/)
 *   changeset → /changeset/:id   (changeset id == PR number; mt#2535 added the route)
 *
 * @see tabs.tsx `matchEntityRoute` — the reverse codec (path → entity)
 * @see mt#2517 — parent umbrella
 * @see mt#2518 — this task
 * @see mt#2536 — PR/changeset linkification (this task)
 */

/** Entity types that have a routable cockpit detail page. */
export type RoutableEntityType = "task" | "ask" | "session" | "memory" | "changeset";

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
 * Parse a `minsky://` URI back to `{type, id}`.
 *
 * Returns `null` when the input is not a valid `minsky://` URI or the type
 * is not one of the five routable entity types.
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
  // Strip trailing prose-punctuation (`.` `,` `)` `]` `;`) that a terminal's URL
  // auto-detection commonly captures from a markdown link like
  // `[mt#2370](minsky://task/mt%232370)` — without this the trailing `)` decodes
  // INTO the id (`mt#2370)`) and the entity lookup fails ("Task mt#2370) not found",
  // mt#2549). The in-cockpit transcript linkifier (entity-linkifier.tsx) already
  // excludes these chars at match time; this mirrors that discipline for the
  // EXTERNAL deep-link path (mt#2528), which receives raw OS-delivered URLs. No
  // valid task/ask/session/memory id ends in these characters, so the strip is safe.
  const rawId = withoutScheme.slice(slashIdx + 1).replace(/[.,);\]]+$/, "");

  // Validate type
  const validTypes: RoutableEntityType[] = ["task", "ask", "session", "memory", "changeset"];
  if (!(validTypes as string[]).includes(rawType)) return null;

  // Id must not be empty
  if (!rawId) return null;

  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }

  // Belt-and-suspenders: also strip trailing prose-punctuation that arrived
  // PERCENT-ENCODED (e.g. `%29` → `)`, `%2E` → `.`, `%5D` → `]`, `%3B` → `;`),
  // which the pre-decode strip above cannot see. Re-check empty in case the id
  // was entirely (encoded) punctuation. No valid id ends in these chars.
  id = id.replace(/[.,);\]]+$/, "");
  if (!id) return null;

  // `changeset` ids are PR numbers — enforce digits-only so a malformed
  // `minsky://changeset/abc` does not parse and route to a nonexistent
  // `/changeset/abc`. The rule/docs pin `changeset id == PR number` (positive
  // integer); other entity types keep their free-form id shape. (mt#2536 R1)
  if (rawType === "changeset" && !/^\d+$/.test(id)) return null;

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
