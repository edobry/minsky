import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { tasksTable } from "./task-embeddings";

/**
 * Work-package tables (ADR-046, mt#2911 — Phase 1 of the conversation-succession RFC).
 *
 * A work package IS a task (kind "work-package" on the tasks table; its spec is
 * the briefing), so there is no work_packages table. These two tables carry what
 * the task row cannot:
 *
 *  - `work_package_members` — the ordered member set. A REFERENCE, deliberately
 *    not parent/child: no status rollup, no graph edge, and members remain
 *    independently governed by task-entry arbitration (warn-peer-task-activity /
 *    mt#4788). `status_at_write` is the per-pointer snapshot that makes
 *    claim-time staleness computable against a fixed baseline (RFC review
 *    finding F7); the live task record always wins.
 *
 *  - `work_package_transfers` — the append-only transfer log. The package row
 *    MUTATES across ownership changes (one row per engagement — the RFC's
 *    2026-08-30 §DECIDED lifecycle call); this log is the immutable
 *    per-transfer record, and `origin` is a per-TRANSFER fact, not a per-row
 *    column: one package can be groomed, claimed, released, and later carry a
 *    succession entry without any row rewrite losing history.
 *
 * Claim identity (`claimed_by` / `claimed_at`) lives on the tasks table itself —
 * written only by the claim path, which is a single conditional UPDATE from
 * READY (CAS). Deliberately NOT built on the 15-minute presence-claims table:
 * presence claims are a liveness heartbeat, a package claim is engagement-long
 * ownership, and conflating those grains is the measured failure mem#1231
 * records.
 */

/** Transfer origins: how a package entered (or re-entered) the claimable pool. */
export const WORK_PACKAGE_TRANSFER_ORIGINS = ["groomed", "succession", "release"] as const;
export type WorkPackageTransferOrigin = (typeof WORK_PACKAGE_TRANSFER_ORIGINS)[number];

export const workPackageMembersTable = pgTable(
  "work_package_members",
  {
    /** The work-package task (kind "work-package"). FK — must be a real task row. */
    packageTaskId: text("package_task_id")
      .notNull()
      .references(() => tasksTable.id),
    /**
     * The member task ref (e.g. "mt#123"). Plain text, NOT an FK: members may
     * live in any backend the tasks table has not ingested, and create-time
     * validation resolves every ref via refs_status anyway (mem#676 R5).
     */
    memberTaskId: text("member_task_id").notNull(),
    /** 1-based position in the briefing's recommended order. */
    rank: integer("rank").notNull(),
    /** Member's task status at write time — the F7 staleness baseline, never authoritative. */
    statusAtWrite: text("status_at_write"),
    /** One-line why-this-task-in-this-bundle, from the briefing. */
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.packageTaskId, table.memberTaskId] })]
);

export const workPackageTransfersTable = pgTable(
  "work_package_transfers",
  {
    packageTaskId: text("package_task_id")
      .notNull()
      .references(() => tasksTable.id),
    /** Monotonic per-package sequence; append-only. */
    seq: integer("seq").notNull(),
    /** One of WORK_PACKAGE_TRANSFER_ORIGINS. Text (not pgEnum) to match the kind column's convention. */
    origin: text("origin").notNull(),
    /** Conversation id of the writer, when known (mt#3943's edge supplies successor linkage). */
    byConversation: text("by_conversation"),
    /** Freeform transfer notes: what is done, what remains, judgment that must survive the fold. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.packageTaskId, table.seq] })]
);
