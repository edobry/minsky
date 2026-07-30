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
 * life, across daemon restarts and actuator respawns — the property mt#3364's
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
    timestamp: turn.createdAt.toISOString(),
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
}

/**
 * Pure mapping — unit-tested directly, independent of any DB fake.
 *
 * `seq` is widened to `number | string` on the way in because postgres-js
 * returns some integer types as strings depending on the column type and
 * driver settings; coercing here keeps every downstream consumer (ordering,
 * id derivation) working with an actual number.
 */
export function mapRawEntityThreadTurnRow(raw: RawEntityThreadTurnRow): EntityThreadTurn {
  const role: EntityThreadTurnRole = raw.role === "agent" ? "agent" : "operator";
  return {
    id: raw.id,
    localId: raw.local_id,
    seq: typeof raw.seq === "string" ? Number.parseInt(raw.seq, 10) : raw.seq,
    role,
    content: raw.content,
    createdAt: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
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
  await db
    .insert(entityThreadsTable)
    .values(values)
    .onConflictDoUpdate({
      target: entityThreadsTable.localId,
      set: { updatedAt: values.updatedAt },
    });
  return { localId, entityType: input.entityType, entityId: input.entityId };
}

export interface AppendEntityThreadTurnInput {
  localId: string;
  role: EntityThreadTurnRole;
  content: string;
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
    INSERT INTO entity_thread_turns (id, local_id, seq, role, content)
    SELECT
      ${input.localId} || '#' || next_seq.value,
      ${input.localId},
      next_seq.value,
      ${input.role},
      ${input.content}
    FROM (
      SELECT COALESCE(MAX(seq), 0) + 1 AS value
      FROM entity_thread_turns
      WHERE local_id = ${input.localId}
    ) AS next_seq
    RETURNING id, local_id, seq, role, content, created_at
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
    SELECT id, local_id, seq, role, content, created_at
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
      SELECT local_id, entity_type, entity_id
      FROM entity_threads
      WHERE local_id = ${localId}
      LIMIT 1
    `);
    const rows = Array.from(
      result as Iterable<{ local_id: string; entity_type: string; entity_id: string }>
    );
    const row = rows[0];
    if (!row) return null;
    return {
      localId: row.local_id,
      entityType: row.entity_type as EntityThreadEntityType,
      entityId: row.entity_id,
    };
  } catch (err) {
    log.warn(`findEntityThread: failed for ${localId}`, {
      error: getLoggableErrorSummary(err),
    });
    throw err;
  }
}
