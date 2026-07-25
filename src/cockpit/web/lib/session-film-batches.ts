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
 * A Skill-invocation tool call falls through the mt#3157 adapter's total
 * fallback (no explicit "Skill" registry entry — see event-adapter.ts's
 * `EXPLICIT_TOOL_REGISTRY` / `inferGenericMapping`), so it lands as
 * `execute` in the `unknown` realm with a synthetic target id of
 * `unknown:Skill` (the `extractTargets` fallback shape
 * `` `${mapping.realm}:${name}` `` where `name` is the bare tool name). That
 * id shape is this module's detection signal for a chapter boundary — the
 * session structure the RFC says "the data already carries."
 */
const SKILL_TARGET_ID = "unknown:Skill";

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

/** Derive chapter markers (one per Skill-invocation row) from an ordered event/batch-row pair. */
export function deriveChapters(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[]
): ChapterMarker[] {
  const chapters: ChapterMarker[] = [];
  for (const row of batchRows) {
    for (const idx of row.eventIndices) {
      const event = events[idx];
      if (event && event.target.id === SKILL_TARGET_ID) {
        const skillName = skillNameFromRaw(event.target.raw);
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
