/**
 * Drizzle schema for `entity_threads` + `entity_thread_turns` (mt#3364, parent
 * mt#3363).
 *
 * A cockpit entity discussion thread: the durable record of a conversation the
 * principal holds ABOUT a Minsky entity (an ask, a task, a changeset, a memory)
 * from that entity's detail page, so "what is this ask actually asking me?" can
 * be answered without leaving the cockpit.
 *
 * ## Why these turns are not `agent_transcripts`
 *
 * A thread's agent is a real driven session (mt#2750) — the genuine `claude`
 * binary — so its turns ARE harness conversation content, and reading them back
 * from `agent_transcripts` via `harness_session_id` looks like it should work.
 * It does not: measured against prod on 2026-07-30, 33 `driven_sessions` rows
 * carried 6 `harness_session_id`s, of which 2 had reached `agent_transcripts` —
 * roughly 6% end-to-end coverage, because that table is fed by a best-effort,
 * lagging JSONL ingest. A thread that sourced its own history there would render
 * empty most of the time. Hence this table.
 *
 * **That claim is scoped to SOURCING, and its number is scoped to a broader
 * population than it reads (mt#4073).** The rejection above is correct and
 * unchanged: this table remains the thread's system of record, because a thread
 * rendering FROM the ingest would go blank whenever ingest lagged. But the 6%
 * is over ALL `driven_sessions`, whose dominant attrition is rows that never
 * linked a conversation id at all (6 of 33 carried one) — an entity thread that
 * has produced an agent reply necessarily initialized its conversation, so that
 * attrition does not apply to it. Re-measured live against prod 2026-08-13,
 * scoped to `local_id LIKE 'entity-thread:%'`: 8 of 8 rows carried a
 * conversation id and 8 of 8 of those conversations had ingested assistant
 * turns. (n=8, and it counts rows that exist today, so read it as "6% is not
 * this population's number" rather than as a coverage guarantee.)
 *
 * This is what lets `entity-thread-transcript-reconciler.ts` use the ingest as a
 * BACKSTOP for turns already missing here. Do not read the 6% as ruling that
 * out — a backstop with imperfect coverage still dominates silent loss, and its
 * bad day is a late recovery, not a blank thread.
 *
 * The converse also holds and is load-bearing: nothing here is ever written INTO
 * `agent_transcripts`. That table is the ingest-shaped mirror of on-disk harness
 * JSONL (`harness`, `cwd`, `project_dir`, `last_ingested_jsonl_timestamp`,
 * `ingest_quarantined_at`); a cockpit-native turn has no JSONL behind it, so
 * dual-writing would corrupt its system-of-record semantics.
 *
 * ## Identity: `localId` is shared with `driven_sessions`, not parallel to it
 *
 * `entityThreads.localId` is the SAME id passed to `startDrivenSession`'s
 * `localId` option (`src/cockpit/driven-session-host.ts`, mt#3243), whose doc
 * comment describes exactly this use: "a caller that must find the same
 * conversation again after its own memory is gone — the principal channel,
 * across a daemon restart — supplies a stable one. The store upserts on this
 * key." Deriving it deterministically from the entity ref (see
 * `entityThreadLocalId` in ../../transcripts/entity-thread-store.ts) means a
 * thread resolves to ONE `driven_sessions` row for its whole life, across any
 * number of daemon restarts and respawns, with no mapping lookup — and no
 * second identity key competing with the one mt#3038/mt#3243 already
 * established.
 *
 * ## Conventions followed (from ./driven-sessions-schema.ts)
 *
 * Status-like and role-like columns are plain `text`, not pg enums — cheap to
 * extend without an enum migration. `updatedAt` has NO Postgres trigger; the
 * refresh guarantee lives at the application layer in the store module's single
 * write path, which sets it explicitly in BOTH the insert and
 * `onConflictDoUpdate` arms.
 *
 * @see mt#3364 — this schema
 * @see mt#3363 — parent (the cockpit entity discussion thread)
 * @see ./driven-sessions-schema.ts — the session record this shares `localId` with
 * @see ../../transcripts/entity-thread-store.ts — the read/write module
 */

import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The entity kinds a thread can attach to — the routable set the cockpit
 * already recognizes (`src/cockpit/web/lib/entity-codec.ts`'s
 * `RoutableEntityType`, mirrored by `AskDetail.tsx`'s `ROUTABLE_CONTEXT_KINDS`).
 *
 * mt#3364 ships the `ask` mount; mt#3366 generalizes to task/changeset/memory.
 * The column accepts all of them from day one so generalizing needs no
 * migration — the restriction in mt#3364 is at the mount site, not the schema.
 */
export type EntityThreadEntityType = "ask" | "task" | "changeset" | "memory" | "session";

/**
 * Who produced a turn. Deliberately NOT the harness's `user`/`assistant`
 * vocabulary: the principal is an operator, not a "user", and this thread's
 * agent is one participant among the several a Minsky entity accumulates.
 * Projected to the render layer's block types by `turnToSnapshotBlock`.
 */
export type EntityThreadTurnRole = "operator" | "agent";

export const entityThreadsTable = pgTable(
  "entity_threads",
  {
    /**
     * Shared with `driven_sessions.local_id` — see the module docblock's
     * "Identity" section. Deterministically derived from
     * (`entityType`, `entityId`); never randomly generated.
     */
    localId: text("local_id").primaryKey(),

    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** No DB trigger — refreshed explicitly by the store's single write path. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * The conversation a fresh seeded agent REPLACED, when one was replaced
     * (mt#4093). Null for the overwhelmingly common case: a thread whose agent
     * has always been the same conversation.
     *
     * This has to live here rather than on `driven_sessions`, which is where
     * the conversation id otherwise lives, because a fresh spawn UPSERTS that
     * row on `local_id` — overwriting `harness_session_id` with the NEW
     * conversation. The outgoing id is destroyed by the very spawn that makes
     * it worth recording, so it is captured on the thread instead, which the
     * spawn does not touch.
     *
     * Durable rather than derived because the fact it records is a permanent
     * property of the RENDERED HISTORY: every turn above the swap point belongs
     * to a conversation the current agent cannot see. An in-memory flag would
     * cover the moment of the swap and then vanish on the next daemon restart,
     * leaving later readers with exactly the unbroken-continuity illusion this
     * column exists to break.
     */
    replacedConversationId: text("replaced_conversation_id"),
    /** When {@link replacedConversationId} was replaced. Null iff that is null. */
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
  },
  (table) => ({
    /**
     * One thread per entity. This is what makes `getOrCreateEntityThread`
     * idempotent under concurrent opens of the same detail page (two browser
     * tabs, or a reload racing an in-flight create) rather than relying on the
     * caller to check-then-insert.
     */
    byEntity: uniqueIndex("idx_et_entity").on(table.entityType, table.entityId),
  })
);

export const entityThreadTurnsTable = pgTable(
  "entity_thread_turns",
  {
    /**
     * Also the rendered block id. Namespaced by `entityThreadTurnId` so it can
     * never collide with a snapshot block id — `ConversationView`'s
     * `extraBlocks` seam requires exactly that ("Block ids in `extraBlocks`
     * must NOT collide with snapshot block ids").
     */
    id: text("id").primaryKey(),

    /** FK-by-convention to `entity_threads.local_id` (this schema directory
     * uses plain text refs, not DB-level FKs — see minsky-session-links-schema). */
    localId: text("local_id").notNull(),

    /** Monotonic per-thread ordering. Render order is `seq`, never `createdAt`
     * — two turns written inside the same millisecond must still order. */
    seq: integer("seq").notNull(),

    role: text("role").notNull(),
    content: text("content").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * The conversation this turn was RECOVERED from, when it did not reach this
     * table on the live path (mt#4073). Null for the overwhelmingly common case:
     * a turn the recorder wrote as the reply streamed.
     *
     * Present means the reply was reconciled out of `agent_transcript_turns`
     * after the fact — typically because the append failed and the daemon
     * restarted before the buffer could drain. The panel needs to say so: a
     * recovered turn appends at the TAIL (`seq` is `MAX(seq)+1`, computed inside
     * the insert), so without this column a reply originally sent an hour ago
     * renders as though it had just arrived, which is its own defect.
     *
     * Nullable with no backfill, presence-as-signal, following
     * `entity_threads.replaced_conversation_id` (mt#4093) — see that column's
     * docblock and `mapRawEntityThreadRow` for why a present-but-null key is
     * the thing to avoid when projecting these to a response body.
     */
    recoveredFromConversationId: text("recovered_from_conversation_id"),
    /**
     * When the recovered reply was ORIGINALLY sent, per the transcript turn it
     * came from. Null iff {@link recoveredFromConversationId} is null.
     *
     * Distinct from `createdAt`, which for a recovered turn is when the
     * reconciler wrote the row — minutes or hours after the agent actually said
     * it. Rendering needs the original instant; ordering still uses `seq`.
     */
    originallySentAt: timestamp("originally_sent_at", { withTimezone: true }),
  },
  (table) => ({
    /**
     * Does double duty: serves the only read pattern (all turns for one
     * thread, in `seq` order) AND guards a double-append racing to the same
     * slot. A separate non-unique index on the same column pair would be
     * redundant — Postgres uses this one for the ordered scan.
     */
    uniqueThreadSeq: uniqueIndex("idx_ett_thread_seq_unique").on(table.localId, table.seq),
  })
);

export type EntityThreadRow = typeof entityThreadsTable.$inferSelect;
export type EntityThreadRowInsert = typeof entityThreadsTable.$inferInsert;
export type EntityThreadTurnRow = typeof entityThreadTurnsTable.$inferSelect;
export type EntityThreadTurnRowInsert = typeof entityThreadTurnsTable.$inferInsert;
