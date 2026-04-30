/**
 * BLOCKED subtype derivation — pure render-time helper.
 *
 * Maps an open Ask (if any) to one of four BLOCKED subtypes that appear as
 * `BLOCKED(<subtype>)` in task list/get output.  Derived at render time; the
 * task state-machine is not touched.
 *
 * Mapping per ADR-008 §Task-lifecycle integration:
 *   direction.decide       → "direction"
 *   quality.review         → "review"
 *   authorization.approve  → "authorization"
 *   anything else / null   → "other"
 *
 * Reference: mt#1072, ADR-008.
 */

import type { Ask } from "./types";

/** The four BLOCKED subtypes rendered in task output. */
export type BlockedSubtype = "direction" | "review" | "authorization" | "other";

/**
 * Derive the BLOCKED subtype from the most recent open Ask for the task.
 *
 * @param ask  The open Ask associated with the task, or null when none exists.
 * @returns    One of the four subtypes.
 */
export function deriveBlockedSubtype(ask: Ask | null): BlockedSubtype {
  if (!ask) return "other";

  switch (ask.kind) {
    case "direction.decide":
      return "direction";
    case "quality.review":
      return "review";
    case "authorization.approve":
      return "authorization";
    default:
      return "other";
  }
}

/**
 * Format the BLOCKED status string with subtype suffix.
 *
 * @param ask  The open Ask, or null.
 * @returns    e.g. "BLOCKED(direction)", "BLOCKED(other)"
 */
export function formatBlockedStatus(ask: Ask | null): string {
  return `BLOCKED(${deriveBlockedSubtype(ask)})`;
}
