import { pgTable, text, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects-schema";

/**
 * Presence claims table — task-grain (and future session/subagent-grain) agent presence signal.
 *
 * Records "actor A is working on subject mt#X right now" as a soft, TTL-refreshed claim.
 * Designed grain-agnostic so mt#2284 (session grain) and mt#2292 (subagent grain) can adopt
 * the same table without a breaking schema change:
 *
 *   subject_kind = 'task'     → subject_id is a normalized task id (e.g. "mt#2562")
 *   subject_kind = 'session'  → reserved for mt#2284
 *   subject_kind = 'subagent' → reserved for mt#2292
 *
 * Key design decisions (mt#2562, decision [C] 2026-06-26):
 * - UNIQUE(subject_kind, subject_id, actor_id) → refresh-not-duplicate semantics.
 * - INDEX(subject_kind, subject_id) → the read query ("who is on mt#X?").
 * - project_id STAMPED ON WRITE (mt#2563 lesson: asks shipped without write-stamping).
 * - All where-context columns (cc_conversation_id, tty, host, session_id) nullable.
 *
 * Staleness / TTL:
 *   A claim is stale when last_refreshed_at < now() - PRESENCE_CLAIM_TTL (15m default).
 *   Hard reap at 24h via reapStale(). Actor pid-liveness is deferred (local-only concern).
 *
 * Cross-references: mt#2562 (this), mt#2284 (session grain), mt#2292 (subagent grain),
 * mt#1990 (RFC: substrate), ADR-006 (agent-identity authority tiers).
 */
export const presenceClaimsTable = pgTable(
  "presence_claims",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------
    id: uuid("id").defaultRandom().primaryKey(),

    // Grain discriminator: 'task' for v1; 'session' / 'subagent' reserved
    subjectKind: text("subject_kind").notNull(),

    // Normalized subject identifier.
    // For task grain: the canonical task id, e.g. "mt#2562".
    subjectId: text("subject_id").notNull(),

    // Actor identity: the _meta["io.minsky/agent_id"] value (mt#1078).
    // Resolved via resolveCallerAgentId in src/mcp/server.ts.
    actorId: text("actor_id").notNull(),

    // -------------------------------------------------------------------------
    // Where-context (nullable — all carry the "where" answer for the read surface)
    // -------------------------------------------------------------------------

    // Claude Code conversation id (the cc sessionId / conversation UUID)
    ccConversationId: text("cc_conversation_id"),

    // TTY device path (e.g. /dev/ttys003) — for the terminal-attachment "where"
    tty: text("tty"),

    // Hostname — forward-compat for cross-host mesh presence
    host: text("host"),

    // Minsky session workspace id — set when the claim coincides with a session
    sessionId: text("session_id"),

    // -------------------------------------------------------------------------
    // Project scoping (mt#2563 lesson: stamp on write, not just on read)
    // -------------------------------------------------------------------------
    projectId: uuid("project_id").references(() => projectsTable.id),

    // -------------------------------------------------------------------------
    // Timestamps
    // -------------------------------------------------------------------------
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // UNIQUE: one (actor, subject) pair — repeated activity refreshes, not duplicates
    uniqueActorSubject: uniqueIndex("uq_presence_claims_subject_actor").on(
      table.subjectKind,
      table.subjectId,
      table.actorId
    ),

    // INDEX: the read query ("who is on mt#X?")
    bySubject: index("idx_presence_claims_subject").on(table.subjectKind, table.subjectId),
  })
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type PresenceClaimRecord = typeof presenceClaimsTable.$inferSelect;
export type PresenceClaimInsert = typeof presenceClaimsTable.$inferInsert;
