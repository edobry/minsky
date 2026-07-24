/**
 * Client-side fold: world state at playhead T = fold(events with
 * t_start <= T) (mt#3184 — Watchable world Phase 1, spec SC 3).
 *
 * Playhead addressing: T is encoded as a BATCH-ROW INDEX (see
 * `session-film-batches.ts`), not a raw timestamp — the ribbon's navigation
 * unit (keyboard stepping advances one row) and the fold's playhead unit are
 * the SAME thing by construction, which is what keeps stepping and reading
 * consistent with the no-invented-order rule (spec SC 4). Two events can
 * share an identical `tStart` within one parallel batch, so a raw-timestamp
 * playhead would be ambiguous; a batch-row ordinal is not.
 *
 * Monotone-fold obligation (event-schema.ts's module doc comment): an
 * unpaired tool call (`outcome: undefined`) renders in-flight, and a later
 * REFINEMENT of the SAME occurrence (the same array position, re-applied
 * with more resolved fields) must never regress an already-observed
 * `outcome`/`tEnd` back to unresolved. `applyEvent` below is keyed on the
 * caller-supplied `eventIndex`, not a heuristic match on
 * target/verb/timestamp — two DIFFERENT concurrent touches of the same
 * target in one batch legitimately share `target.id` + `tStart`, so
 * identity must come from the array position, which is unambiguous.
 *
 * @see session-film-batches.ts — BatchRow grouping this module folds over
 * @see session-film-config.ts — the ONE tunables object (keyframe interval)
 */
import type {
  EventActorKind,
  EventOutcome,
  EventRealm,
  EventVerb,
  SemanticEvent,
} from "@minsky/domain/transcripts/event-schema";
import type { BatchRow } from "./session-film-batches";
import type { SessionFilmConfig } from "./session-film-config";

// ── Verbs with no externally-observable target (mirrors event-schema.ts's
// conversational verbs — hand-kept in sync; the frontend bundle does not
// import runtime code from @minsky/domain, per conversations-source.ts's
// established precedent). ────────────────────────────────────────────────
const CONVERSATIONAL_VERBS: ReadonlySet<EventVerb> = new Set([
  "wait",
  "speak",
  "think",
  "ask",
  "respond",
]);

// ── Entity fold state ────────────────────────────────────────────────────

export interface EntityFoldState {
  id: string;
  realm: EventRealm;
  raw?: unknown;
  firstTouchedAt: string;
  lastTouchedAt: string;
  touchCount: number;
  lastVerb: EventVerb;
  /** `undefined` = unresolved/in-flight (mirrors `SemanticEvent.outcome`'s doc comment). */
  lastOutcome: EventOutcome | undefined;
}

// ── Agent fold state ─────────────────────────────────────────────────────

/** Stable key for an actor across the fold: `"principal"`, `"policy:<guard>"`, or `"agent:<agentSessionId>"`. */
export type ActorKey = string;

export function actorKey(actor: {
  kind: EventActorKind;
  agentSessionId?: string;
  guardName?: string;
}): ActorKey {
  if (actor.kind === "principal") return "principal";
  if (actor.kind === "policy") return `policy:${actor.guardName ?? "unknown"}`;
  return `agent:${actor.agentSessionId ?? "unknown"}`;
}

export interface AgentFoldState {
  key: ActorKey;
  kind: EventActorKind;
  agentSessionId?: string;
  guardName?: string;
  /** Every entity id this actor has acted on (non-conversational verbs only) — the touched-set (spec SC 7). */
  touchedEntityIds: Set<string>;
  /** Current excursion target; `null` = at home (idle/drifted home). */
  currentTargetId: string | null;
  lastVerb: EventVerb | null;
  lastOutcome: EventOutcome | undefined;
  /** True only for the duration until this actor's NEXT event (spec: "shimmer only when a thinking block actually exists"). */
  thinking: boolean;
}

// ── World fold state ─────────────────────────────────────────────────────

export interface WorldFoldState {
  entities: Map<string, EntityFoldState>;
  agents: Map<ActorKey, AgentFoldState>;
  /**
   * Records which target/actor each array INDEX was last applied against —
   * lets a later re-application at the SAME index be recognized as a
   * refinement (monotone-fold obligation) rather than a brand-new touch,
   * without relying on an ambiguous target+timestamp heuristic.
   */
  appliedIndex: Map<number, { targetId: string; actorKey: ActorKey }>;
  /** Highest event-array index folded so far, or -1 if none. */
  lastEventIndex: number;
  /**
   * Target ids touched by the MOST RECENTLY folded batch row, grouped by
   * actor — the stage's fan-out rendering signal (spec SC 5/SC 10). Set by
   * {@link applyRow}, never by bare `applyEvent` calls (which don't know
   * row boundaries) — `foldEvents`, a row-unaware event-level fold used
   * only by tests, leaves this at its initial empty state. Empty when no
   * row has been folded yet via `applyRow`.
   */
  lastRowTargetsByActor: Map<ActorKey, string[]>;
  /**
   * True when the most recently folded row (via {@link applyRow}) was a
   * genuine parallel batch (>1 event sharing a `batchId`) — the stage must
   * render simultaneous fan-out beams for such a row, never an avatar
   * walking sequentially through the targets (spec SC 5/SC 10, AT 1's stage
   * half: "never a sequential walk, never last-target-only").
   */
  lastRowIsParallelBatch: boolean;
}

export function createEmptyWorldState(): WorldFoldState {
  return {
    entities: new Map(),
    agents: new Map(),
    appliedIndex: new Map(),
    lastEventIndex: -1,
    lastRowTargetsByActor: new Map(),
    lastRowIsParallelBatch: false,
  };
}

/** Shallow-clone a WorldFoldState (new Map instances; entries reused — entries are only ever replaced wholesale, never mutated). */
function cloneWorldState(state: WorldFoldState): WorldFoldState {
  return {
    entities: new Map(state.entities),
    agents: new Map(state.agents),
    appliedIndex: new Map(state.appliedIndex),
    lastEventIndex: state.lastEventIndex,
    lastRowTargetsByActor: new Map(state.lastRowTargetsByActor),
    lastRowIsParallelBatch: state.lastRowIsParallelBatch,
  };
}

/**
 * Apply one event to a WorldFoldState, returning a NEW state (pure —
 * `state` is never mutated). `eventIndex` is the event's position in the
 * canonical ordered `events` array; re-calling with the SAME index (a
 * "late-arriving completion" of the same occurrence, per the monotone-fold
 * obligation) refines the existing entity/agent record rather than
 * recording a second independent touch.
 */
export function applyEvent(
  state: WorldFoldState,
  event: SemanticEvent,
  eventIndex: number
): WorldFoldState {
  const entities = new Map(state.entities);
  const agents = new Map(state.agents);
  const appliedIndex = new Map(state.appliedIndex);

  const prevApplication = appliedIndex.get(eventIndex);
  const isRefinement =
    prevApplication !== undefined && prevApplication.targetId === event.target.id;

  // ── Entity refinement ───────────────────────────────────────────────────
  const existingEntity = entities.get(event.target.id);
  if (isRefinement && existingEntity) {
    // Refine in place: NEVER regress an already-resolved outcome/tEnd back
    // to unresolved — the monotone-fold obligation. `?? event.X` only ever
    // ADDS information (fills an undefined) than it never removes it.
    entities.set(event.target.id, {
      ...existingEntity,
      lastOutcome: existingEntity.lastOutcome ?? event.outcome,
      lastTouchedAt: existingEntity.lastTouchedAt,
      lastVerb: existingEntity.lastVerb,
    });
  } else {
    entities.set(event.target.id, {
      id: event.target.id,
      realm: event.target.realm,
      raw: event.target.raw ?? existingEntity?.raw,
      firstTouchedAt: existingEntity?.firstTouchedAt ?? event.tStart,
      lastTouchedAt: event.tEnd ?? event.tStart,
      touchCount: (existingEntity?.touchCount ?? 0) + 1,
      lastVerb: event.verb,
      lastOutcome: event.outcome,
    });
  }

  // ── Agent state ─────────────────────────────────────────────────────────
  const key = actorKey(event.actor);
  const existingAgent = agents.get(key);
  const touchedEntityIds = new Set(existingAgent?.touchedEntityIds ?? []);
  const isConversational = CONVERSATIONAL_VERBS.has(event.verb);
  if (!isConversational) {
    touchedEntityIds.add(event.target.id);
  }

  const thinking = event.actor.kind === "agent" ? event.verb === "think" : false;

  agents.set(key, {
    key,
    kind: event.actor.kind,
    agentSessionId: event.actor.agentSessionId,
    guardName: event.actor.guardName,
    touchedEntityIds,
    currentTargetId: isRefinement
      ? (existingAgent?.currentTargetId ?? (isConversational ? null : event.target.id))
      : isConversational
        ? (existingAgent?.currentTargetId ?? null)
        : event.target.id,
    lastVerb: isRefinement ? (existingAgent?.lastVerb ?? event.verb) : event.verb,
    lastOutcome: isRefinement ? (existingAgent?.lastOutcome ?? event.outcome) : event.outcome,
    thinking: isRefinement ? (existingAgent?.thinking ?? thinking) : thinking,
  });

  appliedIndex.set(eventIndex, { targetId: event.target.id, actorKey: key });

  return {
    entities,
    agents,
    appliedIndex,
    lastEventIndex: Math.max(state.lastEventIndex, eventIndex),
    // Pass through unchanged — only `applyRow` (row-aware) sets these;
    // per-event `applyEvent` has no row-boundary information of its own.
    lastRowTargetsByActor: state.lastRowTargetsByActor,
    lastRowIsParallelBatch: state.lastRowIsParallelBatch,
  };
}

/**
 * Apply a full batch ROW to a WorldFoldState: folds every event in the row
 * (in array order — never inventing an order WITHIN the row, since a
 * parallel batch's events are genuinely simultaneous), then records the
 * row's fan-out signal (`lastRowTargetsByActor` / `lastRowIsParallelBatch`)
 * for the stage to render simultaneous beams rather than a sequential walk.
 *
 * This is the row-grain counterpart to `applyEvent` — `buildKeyframes` and
 * `foldAtBatchIndex` (the paths the real page uses) fold row-by-row via
 * this function so the fan-out signal is always current for whatever row
 * the playhead landed on. `foldEvents` (event-index-grain, used only by
 * tests that don't care about row boundaries) does NOT use this — it calls
 * `applyEvent` directly and leaves the fan-out fields at their initial
 * empty state.
 */
export function applyRow(
  state: WorldFoldState,
  events: readonly SemanticEvent[],
  row: BatchRow
): WorldFoldState {
  let next = state;
  for (const eventIdx of row.eventIndices) {
    const event = events[eventIdx];
    if (event) next = applyEvent(next, event, eventIdx);
  }

  const targetsByActor = new Map<ActorKey, string[]>();
  for (const eventIdx of row.eventIndices) {
    const event = events[eventIdx];
    if (!event) continue;
    const key = actorKey(event.actor);
    const list = targetsByActor.get(key) ?? [];
    list.push(event.target.id);
    targetsByActor.set(key, list);
  }

  return {
    ...next,
    lastRowTargetsByActor: targetsByActor,
    lastRowIsParallelBatch: row.isParallelBatch,
  };
}

/** Fold a full ordered `events` array from empty state through `uptoEventIndex` (inclusive). */
export function foldEvents(
  events: readonly SemanticEvent[],
  uptoEventIndex: number
): WorldFoldState {
  let state = createEmptyWorldState();
  const end = Math.min(uptoEventIndex, events.length - 1);
  for (let i = 0; i <= end; i++) {
    const event = events[i];
    if (event) state = applyEvent(state, event, i);
  }
  return state;
}

// ── Keyframes (cheap reverse-scrolling — spec SC 3's "Redux DevTools move") ─

export interface Keyframe {
  /** The batch-ROW index this keyframe was captured AFTER (inclusive). */
  batchRowIndex: number;
  state: WorldFoldState;
}

/**
 * Build keyframe snapshots at `config.keyframeIntervalBatches`-row
 * intervals, always including a keyframe at row 0 (batchRowIndex -1 = empty
 * state, the pre-session frame) so `foldAtBatchIndex` never has to fold the
 * whole array from scratch for an early playhead position.
 */
export function buildKeyframes(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[],
  config: SessionFilmConfig
): Keyframe[] {
  const keyframes: Keyframe[] = [{ batchRowIndex: -1, state: createEmptyWorldState() }];
  let state = createEmptyWorldState();
  for (let rowIdx = 0; rowIdx < batchRows.length; rowIdx++) {
    const row = batchRows[rowIdx];
    if (!row) continue;
    state = applyRow(state, events, row);
    const interval = Math.max(1, config.keyframeIntervalBatches);
    if ((rowIdx + 1) % interval === 0) {
      keyframes.push({ batchRowIndex: rowIdx, state: cloneWorldState(state) });
    }
  }
  return keyframes;
}

/**
 * Fold-at-batch-index using the nearest PRECEDING keyframe, folding forward
 * only the delta — the cheap-reverse-scrolling path the spec's keyframe
 * interval exists for.
 */
export function foldAtBatchIndex(
  events: readonly SemanticEvent[],
  batchRows: readonly BatchRow[],
  keyframes: readonly Keyframe[],
  targetBatchIndex: number
): WorldFoldState {
  if (targetBatchIndex < 0) return createEmptyWorldState();

  let base: Keyframe = keyframes[0] ?? { batchRowIndex: -1, state: createEmptyWorldState() };
  for (const kf of keyframes) {
    if (kf.batchRowIndex <= targetBatchIndex && kf.batchRowIndex > base.batchRowIndex) {
      base = kf;
    }
  }

  let state = cloneWorldState(base.state);
  for (let rowIdx = base.batchRowIndex + 1; rowIdx <= targetBatchIndex; rowIdx++) {
    const row = batchRows[rowIdx];
    if (!row) break;
    state = applyRow(state, events, row);
  }
  return state;
}
