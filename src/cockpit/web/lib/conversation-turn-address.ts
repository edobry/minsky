/**
 * Turn addressing for the conversation surface (mt#3791).
 *
 * A session-film ribbon row knows exactly which transcript line its event came
 * from — `SemanticEvent.sourceRef` carries `turnIndex` plus, for a tool call,
 * `toolUseId`. The conversation view renders those same lines. This module is
 * the address that joins the two: a URL encoding, the DOM-anchor attribute
 * names both sides agree on, and the lookup that turns one into the other.
 *
 * Why a SEARCH param and not a path segment or a hash: the segment after
 * `/conversation/:id` already names the tab (`RunDetail`'s `tabFromPathname`),
 * and `pathForTab` navigates to a bare path — so a hash would be dropped the
 * moment the reader switched tabs, and a segment would be read as a tab name.
 * Two readable keys rather than one opaque value so a hand-edited URL still
 * makes sense, and so mt#3694's peek param (`?p=`) can coexist untouched.
 *
 * The join key is `turnIndex`: the transcript array position stamped on both
 * `SemanticEvent.sourceRef` (`event-schema.ts`) and
 * `SessionContextSnapshotBlock.turnIndex` (`context/types.ts`, whose docblock
 * records the index identity). It is NOT stable across a re-ingest that
 * reorders lines, so a stale address must resolve to nothing and be reported —
 * never to whichever turn happens to sit at that position now.
 */

export const TURN_PARAM = "turn";
export const TOOL_USE_PARAM = "toolUse";

/** Attribute a rendered turn carries so an address can find it in the DOM. */
export const TURN_ANCHOR_ATTR = "data-turn-index";
/** Attribute a rendered tool call carries, for a tool-grain address. */
export const TOOL_USE_ANCHOR_ATTR = "data-tool-use-id";

/**
 * How an addressed turn or call marks itself.
 *
 * Lives beside the address rather than in either renderer because a turn-grain
 * and a tool-grain arrival must look the same — the reader is being shown "this
 * is the thing you clicked", and two different treatments for one meaning would
 * read as two different states. Semantic ring tokens only, per
 * `src/cockpit/CLAUDE.md` §Semantic tokens.
 */
export const ADDRESSED_MARK_CLASS = "ring-2 ring-ring ring-offset-2 ring-offset-background";

export interface TurnAddress {
  /** Transcript array position — `SessionContextSnapshotBlock.turnIndex`. */
  turnIndex: number;
  /** Which tool call within that turn, when the address is tool-grain. */
  toolUseId?: string;
}

/**
 * Read an address off a URL query string. Returns `null` when none is present
 * OR when what is present is malformed — the two are the same to a caller,
 * which lands on the newest exchange either way.
 */
export function parseTurnAddress(search: string | URLSearchParams): TurnAddress | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get(TURN_PARAM);
  if (raw === null) return null;
  // Digits only, deliberately stricter than `Number`: `Number("")` is 0 and
  // `parseInt("3x")` is 3, so a malformed param would otherwise resolve to a
  // turn nobody named — silently landing somewhere plausible is the one
  // outcome worse than not landing at all.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const turnIndex = Number(trimmed);
  if (!Number.isSafeInteger(turnIndex)) return null;
  const toolUseId = params.get(TOOL_USE_PARAM)?.trim();
  return toolUseId ? { turnIndex, toolUseId } : { turnIndex };
}

/** Encode an address as a query string, `?`-prefixed and ready to append. */
export function turnAddressSearch(address: TurnAddress): string {
  const params = new URLSearchParams();
  params.set(TURN_PARAM, String(address.turnIndex));
  if (address.toolUseId) params.set(TOOL_USE_PARAM, address.toolUseId);
  return `?${params.toString()}`;
}

/**
 * Find the element an address points at, within `container`.
 *
 * Attribute values are compared in JS rather than composed into a selector:
 * a `tool_use` id is opaque third-party text, and quoting it into an attribute
 * selector would need escaping that has nothing to do with this lookup.
 */
export function findAddressedElement(
  container: ParentNode,
  address: TurnAddress
): HTMLElement | null {
  const turnEl =
    Array.from(container.querySelectorAll<HTMLElement>(`[${TURN_ANCHOR_ATTR}]`)).find(
      (el) => el.getAttribute(TURN_ANCHOR_ATTR) === String(address.turnIndex)
    ) ?? null;
  if (!turnEl || !address.toolUseId) return turnEl;

  const toolEl =
    Array.from(turnEl.querySelectorAll<HTMLElement>(`[${TOOL_USE_ANCHOR_ATTR}]`)).find(
      (el) => el.getAttribute(TOOL_USE_ANCHOR_ATTR) === address.toolUseId
    ) ?? null;
  // The turn resolved but the named call inside it did not — the call was
  // merged away by the command-invocation pass, or its id changed across a
  // re-ingest. The turn is still the right place to land, so degrade to it
  // rather than declaring the whole address unresolvable.
  return toolEl ?? turnEl;
}
