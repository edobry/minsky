/**
 * peek-codec — the URL contract for the side peek (mt#3694).
 *
 * The peek's state is an ORDERED LIST of panes carried in one query parameter,
 * so a peeked state survives copy / share / reload. Notion's `?p=` convention
 * is the precedent; the list shape (rather than a single id) is what the
 * settled interaction model needs — see mt#3694 `## Context → Settlement`:
 * an ordinary click REPLACES the last pane, and one deliberate hold gesture
 * keeps the current pane so the next click lands beside it.
 *
 * This module is deliberately pure — no React, no router. It is the functional
 * core the provider's imperative shell drives, which is what lets the whole
 * URL contract be tested without mounting anything.
 *
 * ## Wire format
 *
 *   peek=<pane>[,<pane>...]        where <pane> = ["*"]<type>":"<encoded id>
 *
 * The leading `*` marks a HELD pane. The id is percent-encoded INSIDE the
 * value, on top of whatever encoding `URLSearchParams` applies to the value as
 * a whole. That double pass looks redundant and is not: it is what makes an id
 * containing the delimiters (`,` `:`) round-trip. No id in today's set contains
 * either, so the encoding is doing nothing visible right now — it is here so
 * that a future id shape cannot silently corrupt the pane list, which would
 * present as panes vanishing rather than as an error.
 *
 * ## Robustness
 *
 * A URL is hand-editable and shareable, so decoding treats its input as
 * untrusted: an unparseable pane, an unknown entity type, or an empty id is
 * DROPPED rather than thrown on. A malformed peek param degrades to fewer
 * panes (or none) and leaves the underlying page usable — the alternative is a
 * shell that a pasted URL can crash.
 */
import { ROUTABLE_ENTITY_TYPES, type RoutableEntityType } from "./entity-codec";

/** Query-parameter name carrying the pane list. */
export const PEEK_PARAM = "peek";

const HELD_MARKER = "*";
const PANE_SEPARATOR = ",";
const TYPE_SEPARATOR = ":";

/**
 * Decode-side sanity bound on pane count.
 *
 * This is NOT the cap-and-eviction policy the settled model deliberately does
 * without: interactively, growth costs a hold gesture per pane, so a human
 * cannot accumulate panes by accident and no eviction is needed. This bound
 * exists only because a URL is not produced interactively — a hand-crafted or
 * programmatically-generated link could otherwise ask the shell to mount an
 * unbounded number of panes at once. Panes beyond the bound are dropped.
 */
export const MAX_DECODED_PANES = 16;

export interface PeekPane {
  type: RoutableEntityType;
  id: string;
  /**
   * A held pane survives the next ordinary open, which lands beside it rather
   * than replacing it. Only the LAST pane is ever unheld — see `openPane`.
   */
  held: boolean;
}

/** True when both panes address the same entity (ignoring hold state). */
export function samePane(a: Pick<PeekPane, "type" | "id">, b: Pick<PeekPane, "type" | "id">) {
  return a.type === b.type && a.id === b.id;
}

/**
 * Serialize panes to a query-parameter VALUE, or `null` when there are none.
 *
 * `null` (rather than `""`) is the signal to DELETE the parameter, so a closed
 * peek leaves no `?peek=` residue in the URL the operator copies.
 */
export function encodePeekPanes(panes: readonly PeekPane[]): string | null {
  if (panes.length === 0) return null;
  return panes
    .map((p) => `${p.held ? HELD_MARKER : ""}${p.type}${TYPE_SEPARATOR}${encodeURIComponent(p.id)}`)
    .join(PANE_SEPARATOR);
}

function decodeOnePane(raw: string): PeekPane | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const held = trimmed.startsWith(HELD_MARKER);
  const body = held ? trimmed.slice(HELD_MARKER.length) : trimmed;

  // Split on the FIRST separator only: entity types never contain `:`, but an
  // id conceivably could once decoded, and the type is the unambiguous half.
  const sep = body.indexOf(TYPE_SEPARATOR);
  if (sep === -1) return null;

  // Not a display truncation: this splits at an `indexOf` delimiter index, and
  // the left half is an entity type from ROUTABLE_ENTITY_TYPES — guaranteed
  // ASCII, and rejected below if it is not one of them. No surrogate pair can
  // straddle the cut, which is the failure `no-unsafe-string-truncation` guards.
  // eslint-disable-next-line custom/no-unsafe-string-truncation
  const type = body.slice(0, sep);
  if (!(ROUTABLE_ENTITY_TYPES as readonly string[]).includes(type)) return null;

  let id: string;
  try {
    id = decodeURIComponent(body.slice(sep + TYPE_SEPARATOR.length));
  } catch {
    // A malformed percent-escape ("%zz") throws; drop the pane rather than
    // letting a bad URL take down the shell that renders it.
    return null;
  }
  if (!id) return null;

  return { type: type as RoutableEntityType, id, held };
}

/**
 * Parse a query-parameter value into panes, dropping anything unparseable.
 *
 * Duplicates are collapsed to their FIRST occurrence, so a URL naming the same
 * entity twice opens one pane for it rather than two identical ones.
 */
export function decodePeekPanes(raw: string | null | undefined): PeekPane[] {
  if (!raw) return [];

  const panes: PeekPane[] = [];
  for (const chunk of raw.split(PANE_SEPARATOR)) {
    if (panes.length >= MAX_DECODED_PANES) break;
    const pane = decodeOnePane(chunk);
    if (!pane) continue;
    if (panes.some((existing) => samePane(existing, pane))) continue;
    panes.push(pane);
  }
  return panes;
}

/**
 * Apply an ordinary OPEN to a pane list — the default click.
 *
 * The last pane is replaced unless it is held, in which case the new pane is
 * appended beside it. This one function is where the settled model lives: no
 * cap, no eviction, and no push-down burial, because a pane only survives an
 * open when someone deliberately held it.
 */
export function openPane(
  panes: readonly PeekPane[],
  next: Pick<PeekPane, "type" | "id">
): PeekPane[] {
  const kept = panes.length > 0 && panes[panes.length - 1]?.held ? [...panes] : panes.slice(0, -1);

  // Re-opening an entity that is already on screen focuses it rather than
  // mounting a second copy of it — without this, clicking the same ref twice
  // in a held assembly silently duplicates a pane.
  const existing = kept.findIndex((p) => samePane(p, next));
  if (existing !== -1) return kept;

  return [...kept, { type: next.type, id: next.id, held: false }];
}

/** Mark the pane at `index` held, so the next ordinary open lands beside it. */
export function holdPane(panes: readonly PeekPane[], index: number): PeekPane[] {
  if (index < 0 || index >= panes.length) return [...panes];
  return panes.map((p, i) => (i === index ? { ...p, held: true } : p));
}

/**
 * Close the pane at `index` (default: the last one).
 *
 * Closing leaves the remaining panes' hold flags alone EXCEPT on the new last
 * pane, which is released: "held" means "survive the next open", and the last
 * pane is the one an open would replace, so a held flag left there would make
 * the next click append instead of replace — a stack by accident, which is the
 * failure mode the settled model exists to avoid.
 */
export function closePane(panes: readonly PeekPane[], index?: number): PeekPane[] {
  const target = index ?? panes.length - 1;
  if (target < 0 || target >= panes.length) return [...panes];
  const remaining = panes.filter((_, i) => i !== target);
  if (remaining.length === 0) return [];
  return remaining.map((p, i) => (i === remaining.length - 1 ? { ...p, held: false } : p));
}
