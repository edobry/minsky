/**
 * Remainder disposition — pure core (mt#5131, Prioritization Phase 1d).
 *
 * The RFC (3ae937f0 §Roadmap Phase 1) gives the backlog's remainder a
 * disposition instead of a count: an open task untouched 90+ days and outside
 * every live standing pointing is PARKED — CLOSED, tagged `auto-expired`, its
 * spec annotated — and RESURRECTED (CLOSED → TODO, tag removed) the moment a
 * pointing's query matches it. This module decides which rows park and which
 * come back, with no IO; `remainder-expiry-store.ts` loads the inputs and
 * applies the plan.
 *
 * Two guards the RFC's sentence does not state but its frame requires:
 *
 * - With ZERO live pointings nothing parks. "Outside every live pointing" is
 *   vacuous then, and a pointing is the thing a task can be outside of. The
 *   plan still names what WOULD park, so a dry-run is informative.
 * - A per-run cap bounds a runaway evaluator (a bug that makes every task
 *   look unmatched) to one run's worth of parks; resurrection is uncapped.
 */

import type { PointingQuery } from "../storage/schemas/pointings-schema";
import { taskMatchesPointingQuery } from "./pointings";

export const AUTO_EXPIRED_TAG = "auto-expired";
export const REMAINDER_AGE_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/** Statuses a session owns — never parked from under it. */
const SESSION_OWNED = new Set(["IN-PROGRESS", "IN-REVIEW"]);
/** Kinds that are containers or claim objects, never remainder. */
const EXCLUDED_KINDS = new Set(["work-package", "umbrella"]);

/** The slice of a task the predicate, the matcher and the annotations need. */
export interface RemainderTaskRow {
  id: string;
  status: string;
  kind: string;
  tags: string[];
  updatedAtMs: number;
}

export interface RemainderPointing {
  id: string;
  name: string;
  query: PointingQuery;
}

export interface RemainderPlanOptions {
  nowMs: number;
  ageDays?: number;
  /** Maximum parks per run; `undefined` = uncapped (the CLI's execute). */
  cap?: number;
}

export interface RemainderPlan {
  /** Ids to park this run, oldest first, after the cap. */
  park: string[];
  /** Ids that meet the predicate and match no pointing, before the cap and the zero-pointing guard. */
  wouldPark: string[];
  /** Parked ids a live pointing now matches, with the first matching pointing. */
  resurrect: Array<{ id: string; pointingId: string; pointingName: string }>;
  /** Set when live pointings are absent — parks are withheld, not computed away. */
  parkingSuspended: "no live pointings" | null;
  /** True when `park` was truncated to the cap. */
  capped: boolean;
  /** Ids of the live pointings every decision was checked against. */
  pointingIds: string[];
}

/** Open, not session-owned, not a container/claim kind, untouched for `ageDays`. */
export function isRemainderCandidate(
  row: Pick<RemainderTaskRow, "status" | "kind" | "updatedAtMs">,
  nowMs: number,
  ageDays: number = REMAINDER_AGE_DAYS
): boolean {
  if (row.status === "DONE" || row.status === "CLOSED") return false;
  if (SESSION_OWNED.has(row.status)) return false;
  if (EXCLUDED_KINDS.has(row.kind)) return false;
  return nowMs - row.updatedAtMs >= ageDays * MS_PER_DAY;
}

/** A task this mechanism parked: CLOSED and carrying the tag. */
export function isParkedRow(row: Pick<RemainderTaskRow, "status" | "tags">): boolean {
  return row.status === "CLOSED" && row.tags.includes(AUTO_EXPIRED_TAG);
}

function firstMatchingPointing(
  row: Pick<RemainderTaskRow, "id" | "tags">,
  pointings: readonly RemainderPointing[],
  ancestorsOf: (taskId: string) => string[]
): RemainderPointing | undefined {
  return pointings.find((p) => taskMatchesPointingQuery(row, p.query, ancestorsOf));
}

/**
 * Decide the run. Idempotent by construction: a parked row is never a
 * candidate (it is CLOSED), and an open row is never resurrected (it is not
 * parked), so a second run over the same inputs plans nothing.
 */
export function planRemainderSweep(
  rows: readonly RemainderTaskRow[],
  pointings: readonly RemainderPointing[],
  ancestorsOf: (taskId: string) => string[],
  options: RemainderPlanOptions
): RemainderPlan {
  const ageDays = options.ageDays ?? REMAINDER_AGE_DAYS;
  const wouldPark = rows
    .filter((r) => isRemainderCandidate(r, options.nowMs, ageDays))
    .filter((r) => firstMatchingPointing(r, pointings, ancestorsOf) === undefined)
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
    .map((r) => r.id);

  const resurrect: RemainderPlan["resurrect"] = [];
  for (const r of rows) {
    if (!isParkedRow(r)) continue;
    const p = firstMatchingPointing(r, pointings, ancestorsOf);
    if (p) resurrect.push({ id: r.id, pointingId: p.id, pointingName: p.name });
  }

  const parkingSuspended = pointings.length === 0 ? "no live pointings" : null;
  const uncapped = parkingSuspended ? [] : wouldPark;
  const park = options.cap === undefined ? uncapped : uncapped.slice(0, Math.max(0, options.cap));
  return {
    park,
    wouldPark,
    resurrect,
    parkingSuspended,
    capped: park.length < uncapped.length,
    pointingIds: pointings.map((p) => p.id),
  };
}

// ─── Spec annotations ────────────────────────────────────────────────────────

function isoDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Appended to a parked task's spec — the decision, auditable on the task. */
export function autoExpiredSection(nowMs: number, pointingIds: readonly string[]): string {
  const checked = pointingIds.length ? pointingIds.join(", ") : "(none live)";
  return [
    "",
    `## Auto-expired (${isoDate(nowMs)})`,
    "",
    `Parked by the remainder-expiry sweep (mt#5131): open, untouched ${REMAINDER_AGE_DAYS}+ days, and`,
    `matching no live standing pointing. Pointings checked: ${checked}. A pointing whose`,
    "query matches this task reopens it (CLOSED → TODO) automatically.",
    "",
  ].join("\n");
}

/** Appended to a resurrected task's spec. */
export function resurrectedSection(
  nowMs: number,
  pointing: Pick<RemainderPointing, "id" | "name">
): string {
  return [
    "",
    `## Resurrected (${isoDate(nowMs)}) by pointing ${pointing.id}`,
    "",
    `Reopened by the remainder-expiry sweep (mt#5131): standing pointing "${pointing.name}"`,
    `(${pointing.id}) matches this task.`,
    "",
  ].join("\n");
}

/** Tag list after a park / a resurrection. */
export function tagsAfterPark(tags: readonly string[]): string[] {
  return tags.includes(AUTO_EXPIRED_TAG) ? [...tags] : [...tags, AUTO_EXPIRED_TAG];
}

export function tagsAfterResurrect(tags: readonly string[]): string[] {
  return tags.filter((t) => t !== AUTO_EXPIRED_TAG);
}
