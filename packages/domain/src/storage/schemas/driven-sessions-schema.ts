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

import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

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
