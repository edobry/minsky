/**
 * Entity discussion thread store (mt#3364, parent mt#3363).
 *
 * Read/write access to `entity_threads` + `entity_thread_turns`
 * (../storage/schemas/entity-threads-schema.ts) — the durable record of a
 * conversation the principal holds ABOUT a Minsky entity from that entity's
 * cockpit detail page.
 *
 * Follows the conventions of its sibling ./driven-session-registry-store.ts:
 * `db` is passed in (this module never acquires a connection), writes use the
 * drizzle query builder, reads use raw `db.execute(sql\`...\`)` so the row
 * mapping stays independently unit-testable against a trivial `db.execute`
 * fake, and this module imports NOTHING from `src/cockpit/**`.
 *
 * The pure functions here — `entityThreadLocalId`, `entityThreadTurnId`,
 * `turnToSnapshotBlock`, `mapRawEntityThreadTurnRow` — carry the load-bearing
 * invariants (deterministic identity, id namespacing, render projection) and
 * are tested directly, with no DB involved.
 *
 * @see mt#3364 — this module
 * @see ../storage/schemas/entity-threads-schema.ts — the tables
 * @see ./driven-session-registry-store.ts — the sibling this mirrors
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import {
  entityThreadsTable,
  type EntityThreadEntityType,
  type EntityThreadTurnRole,
} from "../storage/schemas/entity-threads-schema";
import type { SessionContextSnapshotBlock } from "../context/types";

/**
 * Re-exported so daemon-side callers (src/cockpit/**) import the thread's types
 * from the thread's own module rather than reaching past it into the schema
 * file — the schema is this module's implementation detail.
 */
export type { EntityThreadEntityType, EntityThreadTurnRole };

// ---------------------------------------------------------------------------
// Identity (pure — the invariants live here)
// ---------------------------------------------------------------------------

/**
 * Namespace prefix for every id this module mints.
 *
 * Load-bearing for rendering: `ConversationView`'s `extraBlocks` seam requires
 * that "Block ids in `extraBlocks` must NOT collide with snapshot block ids,"
 * and snapshot block ids are synthesized from a session id plus a position
 * (see `SessionContextSnapshotBlock.id`). Prefixing every thread id with a
 * string no session id starts with makes the two id spaces disjoint by
 * construction rather than by luck.
 */
export const ENTITY_THREAD_ID_PREFIX = "entity-thread";

/**
 * The stable `localId` for an entity's thread — deterministic, so it never has
 * to be looked up or stored to be re-derived.
 *
 * This is ALSO the id handed to `startDrivenSession`'s `localId` option
 * (mt#3243), which upserts `driven_sessions` on that key. Determinism is what
 * makes an entity resolve to exactly ONE driven-session row for its whole
 * life, across daemon restarts and session driver respawns — the property mt#3364's
 * "same row across a restart, not a new row per spawn" criterion asserts.
 *
 * Deliberately NOT a hash: a readable id makes a `driven_sessions` row
 * self-explanatory when read directly in psql, which is where these get
 * debugged. Entity ids are already URL-safe (uuids, `mt#NNNN`, PR numbers), so
 * the only character needing care is the task `#`.
 */
export function entityThreadLocalId(entityType: EntityThreadEntityType, entityId: string): string {
  return `${ENTITY_THREAD_ID_PREFIX}:${entityType}:${encodeURIComponent(entityId)}`;
}

/** The id of one turn — also its rendered block id. See `ENTITY_THREAD_ID_PREFIX`. */
export function entityThreadTurnId(localId: string, seq: number): string {
  return `${localId}#${seq}`;
}

// ---------------------------------------------------------------------------
// Render projection (pure)
// ---------------------------------------------------------------------------

/**
 * Map a turn's role to the render layer's block type.
 *
 * `ContextElement["type"]` already carries observation-path kinds for exactly
 * this shape (`user-prompt` / `assistant-text`, mt#2033), so a thread turn
 * projects onto the EXISTING taxonomy — no new block type, and no adapter
 * shim between this table and `ConversationView`.
 */
const BLOCK_TYPE_BY_ROLE: Record<EntityThreadTurnRole, SessionContextSnapshotBlock["type"]> = {
  operator: "user-prompt",
  agent: "assistant-text",
};

/**
 * The harness line type each role corresponds to.
 *
 * `SessionContextSnapshotBlock.rawJsonlType` is documented as the "Original
 * JSONL line type (`user` / `assistant` / `attachment` / `system`)". A thread
 * turn has no JSONL line behind it, but it IS the same KIND of thing — an
 * operator message or an assistant message — so it reports the type its
 * harness-equivalent would carry. Inventing a new value here would break every
 * consumer that switches on this field.
 */
const RAW_JSONL_TYPE_BY_ROLE: Record<EntityThreadTurnRole, string> = {
  operator: "user",
  agent: "assistant",
};

export interface EntityThreadTurn {
  id: string;
  localId: string;
  seq: number;
  role: EntityThreadTurnRole;
  content: string;
  createdAt: Date;
  /**
   * The conversation this turn was recovered from (mt#4073), when it reached
   * this table via the reconciler rather than the live recorder. Absent — not
   * null — when the turn landed normally, so spreading a turn onto a response
   * body cannot assert a recovery that did not happen.
   */
  recoveredFromConversationId?: string;
  /** When a recovered turn was ORIGINALLY sent. Present iff the above is. */
  originallySentAt?: Date;
}

/**
 * Project one stored turn to the block shape `ConversationView` renders.
 *
 * `source` is always `"observed"` — the schema's own contract for that field
 * ("Observation-path blocks are always 'observed'"), and accurate here: a
 * thread turn is something that actually happened, not a synthesized summary.
 */
export function turnToSnapshotBlock(turn: EntityThreadTurn): SessionContextSnapshotBlock {
  return {
    id: turn.id,
    type: BLOCK_TYPE_BY_ROLE[turn.role],
    source: "observed",
    content: turn.content,
    // A recovered turn reports when the agent actually SAID it, not when the
    // reconciler wrote the row (mt#4073). `seq` still places it at the tail —
    // it cannot be inserted mid-thread without breaking the append-only
    // allocation — so without the original instant the panel would render an
    // hour-old reply as having just arrived. The route's `recoveredReplies`
    // notice is what explains the resulting out-of-order position.
    timestamp: (turn.originallySentAt ?? turn.createdAt).toISOString(),
    rawJsonlType: RAW_JSONL_TYPE_BY_ROLE[turn.role],
  };
}

/** Shape of one raw turn row as returned by `postgres-js` (snake_case). */
export interface RawEntityThreadTurnRow {
  id: string;
  local_id: string;
  seq: number | string;
  role: string;
  content: string;
  created_at: Date | string;
  recovered_from_conversation_id?: string | null;
  originally_sent_at?: Date | string | null;
}

/**
 * Pure mapping — unit-tested directly, independent of any DB fake.
 *
 * `seq` is widened to `number | string` on the way in because postgres-js
 * returns some integer types as strings depending on the column type and
 * Postgres driver settings; coercing here keeps every downstream consumer (ordering,
 * id derivation) working with an actual number.
 */
export function mapRawEntityThreadTurnRow(raw: RawEntityThreadTurnRow): EntityThreadTurn {
  const role: EntityThreadTurnRole = raw.role === "agent" ? "agent" : "operator";
  const base: EntityThreadTurn = {
    id: raw.id,
    localId: raw.local_id,
    seq: typeof raw.seq === "string" ? Number.parseInt(raw.seq, 10) : raw.seq,
    role,
    content: raw.content,
    createdAt: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
  };

  // Omitted rather than nulled, following `mapRawEntityThreadRow` above: a
  // present-but-null key reads as "we checked and it was not recovered" to
  // anything doing a key check, and these turns are spread onto a response body.
  const recovered = raw.recovered_from_conversation_id?.trim();
  if (!recovered) return base;
  const sentAt = raw.originally_sent_at;
  return {
    ...base,
    recoveredFromConversationId: recovered,
    ...(sentAt ? { originallySentAt: sentAt instanceof Date ? sentAt : new Date(sentAt) } : {}),
  };
}

/** Shape of one raw `entity_threads` row as returned by `postgres-js` (snake_case). */
export interface RawEntityThreadRow {
  local_id: string;
  entity_type: string;
  entity_id: string;
  replaced_conversation_id?: string | null;
  replaced_at?: Date | string | null;
}

/**
 * Project a raw thread row to {@link EntityThread}.
 *
 * The swap columns are OMITTED rather than set to `undefined`/`null` when the
 * row carries no swap, so `{...thread}` onto a response body cannot produce a
 * `replacedConversationId: null` key. The panel treats presence as the signal
 * (the same discipline `originSeeded` and `pendingReplies` already follow at
 * the route), and a present-but-null key would read as "we checked and there
 * was a swap" to anything doing a key check.
 *
 * `replacedAt` is dropped when `replacedConversationId` is absent even if the
 * column somehow holds a timestamp: a swap instant with no conversation behind
 * it is not a fact this can report, and reporting half of it would render a
 * notice naming no conversation.
 */
export function mapRawEntityThreadRow(raw: RawEntityThreadRow): EntityThread {
  const replaced = raw.replaced_conversation_id?.trim();
  const base: EntityThread = {
    localId: raw.local_id,
    entityType: raw.entity_type as EntityThreadEntityType,
    entityId: raw.entity_id,
  };
  if (!replaced) return base;
  const at = raw.replaced_at;
  return {
    ...base,
    replacedConversationId: replaced,
    ...(at ? { replacedAt: at instanceof Date ? at : new Date(at) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface GetOrCreateEntityThreadInput {
  entityType: EntityThreadEntityType;
  entityId: string;
}

export interface EntityThread {
  localId: string;
  entityType: EntityThreadEntityType;
  entityId: string;
  /**
   * The conversation a fresh seeded agent replaced, when one was replaced
   * (mt#4093) — see the schema column's docblock. Absent, not null, when
   * nothing was replaced, so a caller spreading this onto a response body omits
   * the field entirely rather than asserting a swap that did not happen.
   */
  replacedConversationId?: string;
  /** When {@link replacedConversationId} was replaced. Present iff that is. */
  replacedAt?: Date;
}

/**
 * Resolve the thread for an entity, creating its row on first open.
 *
 * Idempotent under concurrent opens of the same detail page (two browser tabs,
 * a reload racing an in-flight create): the insert conflicts on the
 * `idx_et_entity` unique index and degrades to an `updatedAt` touch rather
 * than erroring or minting a second thread.
 *
 * Unlike the sibling driven-session writers, this one THROWS on failure. Those
 * swallow because a lost persistence write must never disturb a live child
 * process; here the caller is a request handler whose entire purpose is to
 * return this thread — swallowing would hand back a thread the caller then
 * writes turns into that no one can ever read.
 */
export async function getOrCreateEntityThread(
  db: PostgresJsDatabase,
  input: GetOrCreateEntityThreadInput
): Promise<EntityThread> {
  const localId = entityThreadLocalId(input.entityType, input.entityId);
  const values = {
    localId,
    entityType: input.entityType,
    entityId: input.entityId,
    updatedAt: new Date(),
  };
  // `returning` (mt#4093): the conflict branch is the COMMON one — an existing
  // thread being touched — and that row may carry a recorded conversation swap
  // the caller has to report. Constructing the result from the INPUT instead,
  // as this did, cannot see any column the caller did not supply.
  const rows = await db
    .insert(entityThreadsTable)
    .values(values)
    .onConflictDoUpdate({
      target: entityThreadsTable.localId,
      set: { updatedAt: values.updatedAt },
    })
    .returning({
      localId: entityThreadsTable.localId,
      entityType: entityThreadsTable.entityType,
      entityId: entityThreadsTable.entityId,
      replacedConversationId: entityThreadsTable.replacedConversationId,
      replacedAt: entityThreadsTable.replacedAt,
    });
  const row = rows[0];
  // Defensive: an upsert that matched and updated always returns its row, but a
  // thread the caller can act on matters more than the swap field, so a missing
  // row degrades to the input-derived shape rather than throwing.
  if (!row) return { localId, entityType: input.entityType, entityId: input.entityId };
  return mapRawEntityThreadRow({
    local_id: row.localId,
    entity_type: row.entityType,
    entity_id: row.entityId,
    replaced_conversation_id: row.replacedConversationId,
    replaced_at: row.replacedAt,
  });
}

/**
 * Record that a fresh seeded agent replaced `replacedConversationId` on this
 * thread (mt#4093).
 *
 * Called at the moment of the swap, from the message path — which is the ONLY
 * moment the outgoing conversation id is still knowable. `driven_sessions` is
 * keyed on the same `local_id` and is about to be upserted by the fresh spawn,
 * overwriting `harness_session_id`; after that the id survives nowhere but the
 * on-disk JSONL.
 *
 * LAST WRITE WINS on a second swap, deliberately. The panel's notice says "the
 * agent answering you has not seen the turns above", which is true of the most
 * recent swap and would be understated by pinning the first one. A full swap
 * HISTORY is a different feature; nothing asks for it yet.
 *
 * Never throws — a thread that works without the notice is strictly better than
 * a message path that 500s because the disclosure could not be written. The
 * failure is logged, and the operator gets the swapped-in agent either way.
 */
export async function recordEntityThreadConversationSwap(
  db: PostgresJsDatabase,
  input: { localId: string; replacedConversationId: string; replacedAt?: Date }
): Promise<void> {
  const replaced = input.replacedConversationId.trim();
  if (!replaced) return;
  try {
    await db.execute(sql`
      UPDATE entity_threads
      SET replaced_conversation_id = ${replaced},
          replaced_at = ${(input.replacedAt ?? new Date()).toISOString()},
          updated_at = now()
      WHERE local_id = ${input.localId}
    `);
  } catch (err) {
    log.warn(`recordEntityThreadConversationSwap: failed for ${input.localId}`, {
      error: getLoggableErrorSummary(err),
    });
  }
}

export interface AppendEntityThreadTurnInput {
  localId: string;
  role: EntityThreadTurnRole;
  content: string;
  /**
   * Set by the reconciler (mt#4073) when this turn is being restored from the
   * thread's harness transcript rather than written as it streamed. Omit on the
   * live path — the columns stay null, which is what "arrived normally" means.
   */
  recoveredFromConversationId?: string;
  /** The instant the recovered reply was originally sent. */
  originallySentAt?: Date;
}

/**
 * Append one turn, allocating its `seq` atomically.
 *
 * The sequence is computed INSIDE the insert (`coalesce(max(seq), 0) + 1` over
 * the thread's existing rows) rather than read-then-written from application
 * code, so two concurrent appends cannot both claim the same slot on a
 * read-modify-write window. The `idx_ett_thread_seq_unique` index is the
 * backstop if they somehow race anyway; the caller sees the resulting error
 * rather than a silently dropped turn.
 *
 * Returns the stored turn, including the `seq` and `id` the database assigned
 * — the caller must not predict either.
 */
export async function appendEntityThreadTurn(
  db: PostgresJsDatabase,
  input: AppendEntityThreadTurnInput
): Promise<EntityThreadTurn> {
  const result = await db.execute(sql`
    INSERT INTO entity_thread_turns
      (id, local_id, seq, role, content, recovered_from_conversation_id, originally_sent_at)
    SELECT
      ${input.localId} || '#' || next_seq.value,
      ${input.localId},
      next_seq.value,
      ${input.role},
      ${input.content},
      ${input.recoveredFromConversationId ?? null},
      ${input.originallySentAt?.toISOString() ?? null}
    FROM (
      SELECT COALESCE(MAX(seq), 0) + 1 AS value
      FROM entity_thread_turns
      WHERE local_id = ${input.localId}
    ) AS next_seq
    RETURNING id, local_id, seq, role, content, created_at,
      recovered_from_conversation_id, originally_sent_at
  `);

  const rows = Array.from(result as Iterable<RawEntityThreadTurnRow>);
  const row = rows[0];
  if (!row) {
    // No RETURNING row means the INSERT ... SELECT matched nothing, which for
    // this statement shape is not reachable (the subselect always yields one
    // row). Fail loudly rather than returning a fabricated turn.
    throw new Error(`appendEntityThreadTurn: insert returned no row for thread ${input.localId}`);
  }
  return mapRawEntityThreadTurnRow(row);
}

// ---------------------------------------------------------------------------
// Reads (raw SQL — see module docblock for why)
// ---------------------------------------------------------------------------

/**
 * All turns for a thread, in render order.
 *
 * Ordered by `seq`, never `created_at`: two turns written inside the same
 * millisecond would otherwise order arbitrarily, and an operator message
 * rendering after the reply it prompted is the kind of bug that looks like a
 * model failure.
 */
export async function listEntityThreadTurns(
  db: PostgresJsDatabase,
  localId: string
): Promise<EntityThreadTurn[]> {
  const result = await db.execute(sql`
    SELECT id, local_id, seq, role, content, created_at,
      recovered_from_conversation_id, originally_sent_at
    FROM entity_thread_turns
    WHERE local_id = ${localId}
    ORDER BY seq ASC
  `);
  return Array.from(result as Iterable<RawEntityThreadTurnRow>).map(mapRawEntityThreadTurnRow);
}

/**
 * The blocks for a thread, ready to hand to `ConversationView`'s `extraBlocks`.
 *
 * Convenience over `listEntityThreadTurns` + `turnToSnapshotBlock` so callers
 * don't each re-derive the projection — the single place the render contract
 * is applied.
 */
export async function listEntityThreadBlocks(
  db: PostgresJsDatabase,
  localId: string
): Promise<SessionContextSnapshotBlock[]> {
  const turns = await listEntityThreadTurns(db, localId);
  return turns.map(turnToSnapshotBlock);
}

/** Look up an existing thread by entity, without creating one. */
export async function findEntityThread(
  db: PostgresJsDatabase,
  entityType: EntityThreadEntityType,
  entityId: string
): Promise<EntityThread | null> {
  const localId = entityThreadLocalId(entityType, entityId);
  try {
    const result = await db.execute(sql`
      SELECT local_id, entity_type, entity_id, replaced_conversation_id, replaced_at
      FROM entity_threads
      WHERE local_id = ${localId}
      LIMIT 1
    `);
    const rows = Array.from(result as Iterable<RawEntityThreadRow>);
    const row = rows[0];
    if (!row) return null;
    return mapRawEntityThreadRow(row);
  } catch (err) {
    log.warn(`findEntityThread: failed for ${localId}`, {
      error: getLoggableErrorSummary(err),
    });
    throw err;
  }
}
