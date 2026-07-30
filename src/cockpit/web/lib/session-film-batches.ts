/**
 * Batch-row grouping + chapter derivation (mt#3184 — Watchable world Phase 1).
 *
 * The ribbon's row grain is the BATCH, not the raw event (spec SC 4): a
 * parallel tool batch (all `tool_use` blocks sharing one `batchId`, per
 * `event-schema.ts`'s doc comment) collapses into ONE expandable "N parallel
 * actions" row, and keyboard stepping advances one row at a time — this
 * module is the shared grouping every ribbon/stage/keyframe consumer reads,
 * so "one step" means the same thing everywhere.
 *
 * @see packages/domain/src/transcripts/event-schema.ts — `batchId` doc comment
 */
import type { EventVerb, SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { actorKey } from "./session-film-fold";

export interface BatchRow {
  /** Index of this row within the ribbon's batch-row array — the playhead's addressing unit. */
  rowIndex: number;
  /** Indices into the original ordered `events` array belonging to this row. */
  eventIndices: number[];
  /** Shared `batchId` for a genuine parallel batch; `undefined` for a singleton (conversational) row. */
  batchId: string | undefined;
  /** True when this row groups >1 event — renders as the spec's "N parallel actions" row. */
  isParallelBatch: boolean;
  /** Earliest `tStart` across the row's events. */
  tStart: string;
  /** Latest known `tEnd` across the row's events — `undefined` unless EVERY event in the row has resolved. */
  tEnd: string | undefined;
}

/**
 * Group an ordered `SemanticEvent[]` into batch-grain rows. Consecutive
 * events sharing the same defined `batchId` collapse into one row; an event
 * with no `batchId` (every conversational verb — `speak`/`think`/`ask`/
 * `respond`/`wait` — see `event-adapter.ts`'s `emitSimpleEvent`) is always
 * its own row.
 */
export function groupEventsIntoBatchRows(events: readonly SemanticEvent[]): BatchRow[] {
  const rows: BatchRow[] = [];
  let i = 0;
  while (i < events.length) {
    const first = events[i];
    if (!first) break;
    const batchId = first.batchId;
    const eventIndices = [i];
    if (batchId !== undefined) {
      let j = i + 1;
      while (j < events.length && events[j]?.batchId === batchId) {
        eventIndices.push(j);
        j++;
      }
      i = j;
    } else {
      i++;
    }

    const rowEvents = eventIndices.map((idx) => events[idx] as SemanticEvent);
    let tStart = first.tStart;
    let tEnd: string | undefined = first.tEnd;
    let allResolved = tEnd !== undefined;
    for (const e of rowEvents) {
      if (e.tStart < tStart) tStart = e.tStart;
      if (e.tEnd === undefined) {
        allResolved = false;
      } else if (tEnd === undefined || e.tEnd > tEnd) {
        tEnd = e.tEnd;
      }
    }

    rows.push({
      rowIndex: rows.length,
      eventIndices,
      batchId,
      isParallelBatch: eventIndices.length > 1,
      tStart,
      tEnd: allResolved ? tEnd : undefined,
    });
  }
  return rows;
}

// ── Wait-vs-gap distinction (spec SC 4 / AT 4) ───────────────────────────────

/** The verb that renders as an explicit wait EVENT (a CI wait, a rate-limit stall — has duration, is data). */
export const WAIT_VERB: EventVerb = "wait";

/** True when every event in a row is a `wait` — an explicit, data-bearing wait (never a capture gap). */
export function isWaitRow(row: BatchRow, events: readonly SemanticEvent[]): boolean {
  return row.eventIndices.every((idx) => events[idx]?.verb === WAIT_VERB);
}

/**
 * Elapsed ms between the PRECEDING row's resolved end (or its start, if
 * unresolved) and this row's start. A positive gap with no `wait` event
 * covering it is a CAPTURE GAP — "no data captured," the opposite meaning of
 * an explicit wait — and must render visually distinct (spec SC 4 / AT 4).
 */
export function precedingGapMs(rows: readonly BatchRow[], rowIndex: number): number {
  if (rowIndex <= 0) return 0;
  const prev = rows[rowIndex - 1];
  const cur = rows[rowIndex];
  if (!prev || !cur) return 0;
  const prevEnd = Date.parse(prev.tEnd ?? prev.tStart);
  const curStart = Date.parse(cur.tStart);
  if (Number.isNaN(prevEnd) || Number.isNaN(curStart)) return 0;
  return Math.max(0, curStart - prevEnd);
}

// ── Chapter derivation (spec SC 4: "chapter headers derived from Skill invocations") ─

export interface ChapterMarker {
  rowIndex: number;
  label: string;
}

/**
 * A Skill-invocation tool call's detection signal for a chapter boundary —
 * the session structure the RFC says "the data already carries."
 *
 * Pre-mt#3258, `Skill` had no explicit adapter registry entry, so it fell
 * through to the total fallback and landed as `execute` in the `unknown`
 * realm with a synthetic target id of literally `unknown:Skill` — which
 * ALSO leaked that literal string to the operator on both the ribbon and
 * the stage (mt#3258 SC 3's coordinator-verified finding). `event-adapter.ts`
 * now gives `Skill` its own registry entry + extractor
 * (`skillTargetExtractor`), producing `agents:skill:<name>` instead — this
 * module's detection updates to match, checked via a realm+prefix pair
 * (not exact-id equality) since the skill NAME varies per invocation. The
 * OLD `unknown:Skill` shape is still recognized too (belt-and-suspenders
 * for any event stream computed by a not-yet-upgraded adapter build) — see
 * `isSkillInvocationTarget`.
 */
const LEGACY_SKILL_TARGET_ID = "unknown:Skill";
const SKILL_TARGET_ID_PREFIX = "agents:skill:";

function isSkillInvocationTarget(target: { realm: string; id: string }): boolean {
  return target.id === LEGACY_SKILL_TARGET_ID || target.id.startsWith(SKILL_TARGET_ID_PREFIX);
}

function skillNameFromRaw(raw: unknown): string | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    for (const key of ["skill", "name", "command"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
}

/** Fallback skill-name source: the target id itself (`agents:skill:<name>`) when `raw` didn't survive (e.g. a payload boundary that strips it). */
function skillNameFromTargetId(targetId: string): string | null {
  if (!targetId.startsWith(SKILL_TARGET_ID_PREFIX)) return null;
  const name = targetId.slice(SKILL_TARGET_ID_PREFIX.length);
  return name.length > 0 && name !== "unknown" ? name : null;
}

// ── Actor-change annotation (mt#3226 SC 2 / AT 2) ────────────────────────────

/**
 * The row's dominant actor key — the FIRST event's actor (a parallel batch's
 * events always share one actor per `event-adapter.ts`'s batching rule, so
 * "first event's actor" is unambiguous for a genuine parallel batch too).
 */
function rowActorKey(events: readonly SemanticEvent[], row: BatchRow): string | null {
  const firstIdx = row.eventIndices[0];
  const event = firstIdx !== undefined ? events[firstIdx] : undefined;
  return event ? actorKey(event.actor) : null;
}

/**
 * Row indices where the actor CHANGES from the immediately preceding row —
 * a principal interjection, a policy denial, or a subagent spawn boundary
 * (spec SC 2: "actor renders only on actor-CHANGE... never repeated per-row
 * in a single-actor film"). Row 0 is never itself a "change" (there is no
 * preceding row to differ from) — a single-actor film therefore renders
 * ZERO actor markers end to end, matching AT 2's "single-actor fixture
 * renders zero per-row actor repetition."
 */
export function deriveActorChanges(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[]
): ReadonlySet<number> {
  const changes = new Set<number>();
  let previousActor: string | null = null;
  for (let i = 0; i < batchRows.length; i++) {
    const row = batchRows[i];
    if (!row) continue;
    const actor = rowActorKey(events, row);
    if (i > 0 && actor !== null && actor !== previousActor) {
      changes.add(row.rowIndex);
    }
    if (actor !== null) previousActor = actor;
  }
  return changes;
}

/** Derive chapter markers (one per Skill-invocation row) from an ordered event/batch-row pair. */
export function deriveChapters(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[]
): ChapterMarker[] {
  const chapters: ChapterMarker[] = [];
  for (const row of batchRows) {
    for (const idx of row.eventIndices) {
      const event = events[idx];
      if (event && isSkillInvocationTarget(event.target)) {
        const skillName =
          skillNameFromRaw(event.target.raw) ?? skillNameFromTargetId(event.target.id);
        chapters.push({
          rowIndex: row.rowIndex,
          label: skillName ? `Skill: ${skillName}` : "Skill invocation",
        });
        break; // one marker per row, even if a batch fired >1 Skill call
      }
    }
  }
  return chapters;
}
