/**
 * Per-entity action history for the stage's detail panel (mt#3793).
 *
 * The fold (`session-film-fold.ts`) keeps ONE folded snapshot per entity —
 * `lastVerb`, `lastOutcome`, `touchCount` — which is what the stage needs to
 * DRAW a node and all the detail panel ever showed. It is not enough to answer
 * the question an operator actually has when they click one: *what happened to
 * this thing, and when?* A count of 7 says something occurred seven times and
 * names only the seventh.
 *
 * This module recovers the other six. It reads the same ordered `events` array
 * the fold consumes, so it is a projection of the identical source rather than
 * a second bookkeeping path that could disagree with the node the operator is
 * looking at — the fold's own counts and this list are derived from one array,
 * and a divergence between them would be a bug in one of these two functions
 * rather than a sync problem between two stores.
 *
 * Every entry carries the BATCH ROW it belongs to, not its raw event index,
 * because the row is the film's addressing unit — the playhead's position, the
 * ribbon's scroll target, and the `?t=` deep-link all speak rows
 * (`session-film-batches.ts`). Handing the panel a row index is what lets a
 * history line be clicked to scrub there.
 *
 * @see session-film-fold.ts — the folded per-entity snapshot this complements
 * @see session-film-batches.ts — BatchRow, the addressing unit these entries carry
 */
import type {
  EventActorKind,
  EventOutcome,
  EventVerb,
  SemanticEvent,
} from "@minsky/domain/transcripts/event-schema";
import type { BatchRow } from "./session-film-batches";

/** One action, by one actor, on one entity — addressed by the batch row it sits in. */
export interface EntityHistoryEntry {
  /** Index into the original ordered `events` array — stable identity for a React key. */
  eventIndex: number;
  /** The batch row this event belongs to: what the playhead is set to in order to reach it. */
  rowIndex: number;
  verb: EventVerb;
  /** `undefined` = unresolved/in-flight, mirroring `SemanticEvent.outcome`. */
  outcome: EventOutcome | undefined;
  actorKind: EventActorKind;
  /** Ready-to-render actor name — see {@link formatActorLabel}. */
  actorLabel: string;
  tStart: string;
}

/**
 * Map each event index to the batch row containing it. Built once per history
 * derivation rather than scanned per event: a film of N events grouped into M
 * rows would otherwise cost O(N*M) for a panel that opens on every click.
 */
function buildEventIndexToRowIndex(batchRows: readonly BatchRow[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of batchRows) {
    for (const eventIndex of row.eventIndices) map.set(eventIndex, row.rowIndex);
  }
  return map;
}

/**
 * Human-readable actor name for a history line.
 *
 * The film's subject is named "This agent" rather than by id: in a
 * single-subject film it is the actor on nearly every line, and a repeated raw
 * `agent-<hex>` reads as noise — the same reasoning that elides the subject as
 * a self-reference TARGET (`session-film-target-ref.ts`). Other agents keep a
 * truncated id, which is the only handle the event stream carries for them.
 */
export function formatActorLabel(
  actor: { kind: EventActorKind; agentSessionId?: string; guardName?: string },
  subjectAgentId: string | null
): string {
  if (actor.kind === "principal") return "Principal";
  if (actor.kind === "policy") return actor.guardName ? `Guard ${actor.guardName}` : "Guard";
  if (!actor.agentSessionId) return "Agent";
  // `subjectAgentId` is the TARGET-shaped id (`agents:<sessionId>`, per
  // `deriveFilmSubjectAgentId`), so compare against the suffix rather than the
  // whole string — the actor side carries the bare session id.
  if (subjectAgentId !== null && subjectAgentId.endsWith(`:${actor.agentSessionId}`)) {
    return "This agent";
  }
  const id = actor.agentSessionId;
  return `Agent ${id.length > 8 ? id.slice(-8) : id}`;
}

/**
 * Every action taken on `entityId`, in event order, with the batch row each
 * one belongs to. Returns an empty array for an entity nothing has touched
 * (an id not present in the stream) rather than throwing — the panel renders
 * whatever it gets, and an empty history is a legitimate state during the
 * frame after a selection changes.
 */
export function buildEntityHistory(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[],
  entityId: string,
  subjectAgentId: string | null = null
): EntityHistoryEntry[] {
  const rowByEventIndex = buildEventIndexToRowIndex(batchRows);
  const entries: EntityHistoryEntry[] = [];
  events.forEach((event, eventIndex) => {
    if (event.target.id !== entityId) return;
    const rowIndex = rowByEventIndex.get(eventIndex);
    // An event outside every batch row cannot be scrubbed to, so it is dropped
    // rather than given a fabricated row. `groupEventsIntoBatchRows` covers the
    // whole array, so this is unreachable for rows derived from the same
    // events — it guards the case where a caller passes mismatched inputs.
    if (rowIndex === undefined) return;
    entries.push({
      eventIndex,
      rowIndex,
      verb: event.verb,
      outcome: event.outcome,
      actorKind: event.actor.kind,
      actorLabel: formatActorLabel(event.actor, subjectAgentId),
      tStart: event.tStart,
    });
  });
  return entries;
}
