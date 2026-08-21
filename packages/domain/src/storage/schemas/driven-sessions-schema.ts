/**
 * Drizzle schema for `driven_sessions` (mt#3038, RFC "Conversation-first drive"
 * Phase 1 — Notion `3a5937f0-3cb4-814c-990f-c1e3174b33e0`).
 *
 * Durable, REHYDRATABLE record of a cockpit driven session (mt#2750) — makes
 * the in-memory `DrivenSessionRegistry` (`src/cockpit/driven-session-host.ts`)
 * survivable across a daemon restart. Per the RFC's R1 expert-review delta #8
 * (BINDING): this is deliberately a NEW, MUTABLE table with `localId` as its
 * primary key and `harnessSessionId` NULLABLE — it does NOT extend the
 * insert-only `minsky_session_links` convention
 * (./minsky-session-links-schema.ts), because a driven session's row is
 * upserted repeatedly across its lifetime (spawn -> init-link -> exit/crash ->
 * resume-respawn -> ...), not appended-once-per-fact like a link row.
 *
 * One row per LOCAL SESSION (not per turn — contrast
 * ./driven-session-cost-schema.ts, which is one row per turn). `localId` is
 * the daemon's spawn-time id (see `DrivenSessionRecord.localId`'s doc comment
 * in driven-session-host.ts) and is stable across an actuator swap (a
 * resume-respawn constructs a NEW in-memory record but keeps the same
 * `localId` — see the R1 delta #3 "record replacement, not mutation"
 * constraint) — so this table's PK never changes across a resume.
 *
 * `harnessSessionId` is nullable for two reasons: (a) it is unknown until the
 * child's `system/init` event arrives (same as the in-memory record's field),
 * and (b) the R1 delta #2 fourth terminal state — `unrecoverable` with reason
 * `"spawn-died-before-init"` — is exactly the case where a persisted row
 * NEVER gets a harness id (nothing to resume, no transcript).
 *
 * `status` carries the full persisted state-machine range, a superset of the
 * in-memory `DrivenSessionStatus` (spawned/running/exited/crashed): boot
 * reconciliation loads a non-terminal record as `"reconnecting"` (R1 delta
 * #6 — lazy-resume-only, never eager at boot) and a permanently-broken record
 * (deleted cwd, spawn-died-before-init, policy-blocked respawn) is persisted
 * as `"unrecoverable"` with `unrecoverableReason` set (R1 delta #2).
 *
 * `actuatorGeneration` counts actuator swaps (R1 delta #3) — incremented each
 * time a resume-respawn replaces the in-memory record; persisted so cost
 * continuity (R1 delta #7) can attribute rows to a generation without
 * resetting/double-counting across a respawn.
 *
 * `pid`/`pidCmdline` are the ORPHAN-CLEANUP identity pair (R1 delta #4):
 * before killing a PID recorded from a prior daemon lifetime, the caller
 * (see ../../../../src/cockpit/process-identity.ts) verifies the LIVE
 * process at that PID still has a command line matching `pidCmdline` —
 * never a bare `kill(pid)`, because PID reuse over a multi-day idle gap
 * would otherwise risk killing an unrelated process.
 *
 * @see mt#3038 — this schema
 * @see mt#2750 — the driven-session host this table durably backs
 * @see ./driven-session-cost-schema.ts — the sibling per-turn (not per-session) table
 * @see ./minsky-session-links-schema.ts — the insert-only convention this table deliberately does NOT follow
 * @see packages/domain/src/transcripts/driven-session-registry-store.ts — the read/write module
 */

import { pgTable, text, integer, timestamp, index, uuid } from "drizzle-orm/pg-core";

/**
 * Persisted status range (superset of the in-memory `DrivenSessionStatus` in
 * driven-session-host.ts — see that type's own doc comment for why the two
 * ranges differ). Kept as a plain `text` column (not a pg enum) to match this
 * codebase's established convention for status-like columns elsewhere in this
 * schema directory (e.g. `minsky-session-links-schema.ts`'s `linkType`) —
 * cheap to extend without an enum migration.
 */
export type PersistedDrivenSessionStatus =
  | "spawned"
  | "running"
  | "exited"
  | "crashed"
  | "reconnecting"
  | "unrecoverable";

export const drivenSessionsTable = pgTable(
  "driven_sessions",
  {
    localId: text("local_id").primaryKey(),
    harnessSessionId: text("harness_session_id"),

    cwd: text("cwd").notNull(),
    permissionMode: text("permission_mode").notNull(),
    taskId: text("task_id"),
    minskySessionId: text("minsky_session_id"),
    /** The principal-selected model alias (mt#3040), e.g. "fable" — nullable
     * (the CLI resolves its own default when omitted). Persisted so a
     * restart-recovery resume (mt#3038) preserves the original launch's
     * model choice instead of silently falling back to default. */
    model: text("model"),

    status: text("status").notNull(),
    unrecoverableReason: text("unrecoverable_reason"),

    // Orphan-cleanup identity pair (R1 delta #4) — see module docblock.
    pid: integer("pid"),
    pidCmdline: text("pid_cmdline"),

    // Actuator-swap generation counter (R1 delta #3/#7) — 0 for the
    // original spawn, incremented once per resume-respawn.
    actuatorGeneration: integer("actuator_generation").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /**
     * `defaultNow()` covers the INSERT case only — this column intentionally
     * has NO Postgres trigger to refresh it on UPDATE (reviewer round 1,
     * PR #2179: flagged as a potential staleness risk). Consistent with
     * every other timestamped table in this schema directory (none use
     * update triggers), the refresh guarantee lives at the APPLICATION
     * layer instead: `upsertDrivenSessionRecord`
     * (../../transcripts/driven-session-registry-store.ts) is the SOLE
     * write path to this table and explicitly sets `updatedAt: new Date()`
     * in the same `values` object used for BOTH the insert arm and the
     * `onConflictDoUpdate` arm — proven by
     * driven-session-registry-store.test.ts's "refreshes updatedAt to a
     * strictly later value on a second upsert" test, not just asserted here.
     * A future raw-SQL write path bypassing that function would need its
     * own explicit `updated_at` set — there is no DB-level backstop.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byHarnessSessionId: index("idx_ds_harness_session_id").on(table.harnessSessionId),
    byTaskId: index("idx_ds_task_id").on(table.taskId),
    byStatus: index("idx_ds_status").on(table.status),
  })
);

export type DrivenSessionRow = typeof drivenSessionsTable.$inferSelect;
export type DrivenSessionRowInsert = typeof drivenSessionsTable.$inferInsert;

/**
 * Every conversation a driven session has ever adopted (mt#4323, ADR-044).
 *
 * `driven_sessions` above holds ONE `harness_session_id`, and its upsert
 * overwrites it — `onConflictDoUpdate({ target: localId, set: values })` in
 * ../../transcripts/driven-session-registry-store.ts. A daemon restart can
 * spawn a fresh seeded child rather than resuming, so the outgoing
 * conversation id is destroyed by the very spawn that makes it worth
 * recording. mt#4093 answered that with `entity_threads.replaced_conversation_id`,
 * which recovers exactly ONE swap back; a session that swapped twice has
 * already lost the older id.
 *
 * This table is that history, and it is deliberately WIDER than entity
 * threads: the overwriting upsert lives in the shared store, and every driven
 * caller — entity threads, the principal channel, the WS route — reaches it
 * through one host, so a thread-scoped table would have fixed one caller's
 * instance of a hole that lives in all of them (RFC `3bb937f0` §5).
 *
 * ## Insert-only, unlike its parent
 *
 * `driven_sessions`'s docblock above explains why THAT table is mutable and
 * deliberately does NOT follow the insert-only `minsky_session_links`
 * convention: its row is upserted repeatedly across one session's lifetime.
 * This table is the opposite and follows that convention — one row per
 * ADOPTION EVENT, appended once per fact, never updated. The series is a fold
 * over these rows and the incumbency is the interval between consecutive
 * ones; both are DERIVED. Do not add an `ended_at`, and do not mint an id for
 * the series — `local_id` already exists and is deterministically derived, so
 * this is an edge relation, not a new identity (mem#938; RFC §4).
 *
 * ## Disjoint from the transitions log — neither covers the other
 *
 * `conversation-transitions.jsonl` (mt#3943) records a conversation replaced
 * in the SAME SEAT — `/clear`, in-process resume, compact, fork — and
 * `writeConversationMapping` (packages/shared/src/conversation-pid-map.ts)
 * emits one only when a prior mapping exists on the same pid. A daemon
 * respawn is a NEW pid with no prior mapping, so it emits nothing. An
 * ADOPTION is a conversation attached to the same subject-surface ACROSS
 * seats, observable only here. The two record disjoint event classes; reading
 * either as covering the other loses exactly the swaps this table exists for.
 */
/**
 * Why a FRESH conversation was spawned instead of resuming the prior one.
 *
 * **Moved here from `src/cockpit/entity-thread-launch.ts` by mt#4323**, which
 * re-exports it unchanged so every existing consumer is untouched. The move is
 * what makes {@link drivenSessionConversationsTable.adoptionReason}'s
 * "cannot drift" a compile-time fact rather than a comment: the store lives in
 * `packages/domain` and deliberately imports nothing from `src/cockpit/**`, so
 * a union defined only on the daemon side could not be referenced by the table
 * and would have had to be copied — and a copy drifts silently.
 *
 * Introduced by mt#4093, whose panel disclosure and log lines read these same
 * values.
 */
export type FreshSpawnReason =
  /** No persisted row, or no database — this thread has never had an agent. */
  | "no-prior-conversation"
  /** A row exists and names a conversation that cannot be resumed. A SWAP. */
  | "prior-conversation-unrecoverable"
  /** A row exists but never linked a conversation (spawn died before `init`). */
  | "prior-spawn-never-linked"
  /** The resume itself threw — the store may simply be unreachable. */
  | "resume-attempt-failed";

/**
 * Why a driven session adopted a conversation — the full set, written to
 * {@link drivenSessionConversationsTable.adoptionReason}.
 *
 * A fresh spawn carries its {@link FreshSpawnReason}; the two cases that are
 * not fresh spawns get their own values. `initial` is the session's FIRST
 * conversation (there was no prior one to decline), which is distinct from
 * `no-prior-conversation` — that one is a fresh spawn on a thread that HAS a
 * history the daemon could not reach.
 */
export type AdoptionReason = FreshSpawnReason | "initial" | "resumed";

export const drivenSessionConversationsTable = pgTable(
  "driven_session_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * The driven session this adoption belongs to — the same `local_id`
     * {@link drivenSessionsTable} is keyed by. Entity threads inherit it via
     * the shared localId they already use.
     *
     * **Deliberately NOT a foreign key**, though mt#4323's criterion 1
     * originally called for one. Both writes are detached fire-and-forget
     * promises with no ordering guarantee between them: the adoption fires on
     * the harness `init` frame, the parent row is upserted by
     * `createDrivenSessionPersistObserver` on state change, and
     * `upsertDrivenSessionRecord` SWALLOWS its own failures by design. An FK
     * would therefore make the adoption fail whenever the parent write lost
     * the race or errored — silently dropping recovery state in exactly the
     * conditions that make it worth having, which is the failure class this
     * table exists to close. A dangling `local_id` is the strictly better
     * outcome: it still names the session whose span it records.
     */
    localId: text("local_id").notNull(),

    /** The adopted conversation. NOT NULL — an adoption without one is not an adoption. */
    harnessSessionId: text("harness_session_id").notNull(),

    /** Harness that owns the conversation id space (`claude_code` today). */
    harness: text("harness").notNull(),

    /**
     * `driven_sessions.actuator_generation` AT ADOPTION TIME. That column
     * counts actuator swaps but is overwritten with the rest of the row; here
     * each generation finally gets a durable per-generation record (RFC §5).
     */
    actuatorGeneration: integer("actuator_generation").notNull().default(0),

    adoptedAt: timestamp("adopted_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * WHY this conversation was adopted — a `FreshSpawnReason` value, or
     * `initial` / `resumed`. Deliberately the same union mt#4093 already
     * shares across its logs, tests and the panel's swap disclosure, so the
     * table, the log line and the UI cannot drift apart.
     *
     * This is an OBSERVATION, not a judgment: it records what the daemon did
     * and why, which is the same epistemic category mt#3943's transitions
     * occupy — so it does not cross the line that task drew (RFC §4).
     */
    adoptionReason: text("adoption_reason").notNull(),
  },
  (table) => ({
    // `idx_dsc_*` is already taken by driven_session_cost (./driven-session-cost-schema.ts),
    // so this table uses `idx_dsconv_*`. drizzle-kit refuses to generate on a
    // duplicate index name across the schema — the collision is caught at
    // generate time, not at apply time.
    byLocalId: index("idx_dsconv_local_id").on(table.localId),
    byHarnessSessionId: index("idx_dsconv_harness_session_id").on(table.harnessSessionId),
  })
);

export type DrivenSessionConversationRow = typeof drivenSessionConversationsTable.$inferSelect;
export type DrivenSessionConversationInsert = typeof drivenSessionConversationsTable.$inferInsert;
