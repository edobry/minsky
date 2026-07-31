import {
  pgTable,
  text,
  uuid,
  timestamp,
  uniqueIndex,
  index,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects-schema";

/**
 * Presence claims table — task-grain (and future session/subagent-grain) agent presence signal.
 *
 * Records "actor A is working on subject mt#X right now" as a soft, TTL-refreshed claim.
 * Designed grain-agnostic so mt#2284 (session grain) and mt#2292 (subagent grain) can adopt
 * the same table without a breaking schema change:
 *
 *   subject_kind = 'task'     → subject_id is a normalized task id (e.g. "mt#2562")
 *   subject_kind = 'session'  → session-grain runtime attachment (mt#2284; subject_id is the
 *                               Minsky workspace session id). The domain-layer `registeredAt`
 *                               maps onto `lastRefreshedAt` — "repeated activity refreshes
 *                               rather than duplicates" is the same upsert semantics as task grain.
 *   subject_kind = 'subagent' → reserved for mt#2292
 *
 * Key design decisions (mt#2562, decision [C] 2026-06-26):
 * - UNIQUE(subject_kind, subject_id, actor_id) → refresh-not-duplicate semantics.
 * - INDEX(subject_kind, subject_id) → the read query ("who is on mt#X?").
 * - project_id STAMPED ON WRITE (mt#2563 lesson: asks shipped without write-stamping).
 * - All where-context columns (cc_conversation_id, tty, host, session_id) nullable.
 *
 * Grain-specific extras (mt#2284, migration 0056 — deferred nullable additions per mt#2562's
 * plan, "not v1"):
 * - pid: integer — the self-registering process's OS pid (session grain; local-host v0). Used
 *   by the session-grain stale-attachment reaper for pid-liveness checks.
 * - entrypoint: text — `CLAUDE_CODE_ENTRYPOINT` (e.g. "cli", "sdk-cli"), when present.
 * - terminal_context: jsonb — env bag of only-the-keys-present among TERM_PROGRAM,
 *   TERM_SESSION_ID, TERM, TMUX, TMUX_PANE, WEZTERM_PANE, KITTY_WINDOW_ID. Emulator-agnostic:
 *   stores env strings, introspects no terminal app.
 *
 * Staleness / TTL:
 *   A claim is stale when last_refreshed_at < now() - PRESENCE_CLAIM_TTL (15m default).
 *   Hard reap at 24h via reapStale(). Task-grain actor pid-liveness is deferred (local-only
 *   concern); session-grain (mt#2284) uses the new `pid` column for its own reaper instead.
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
    // Session-grain extras (mt#2284, migration 0056). Nullable; unused by task/
    // subagent grain rows.
    // -------------------------------------------------------------------------

    // Self-registering process's OS pid (session grain; local-host v0 — used by
    // the session-attachment stale reaper for pid-liveness checks).
    pid: integer("pid"),

    // CLAUDE_CODE_ENTRYPOINT (e.g. "cli", "sdk-cli"), when present.
    entrypoint: text("entrypoint"),

    // Env bag of only-the-keys-present terminal-context vars (TERM_PROGRAM,
    // TERM_SESSION_ID, TERM, TMUX, TMUX_PANE, WEZTERM_PANE, KITTY_WINDOW_ID).
    // Emulator-agnostic: stores env strings, introspects no terminal app.
    terminalContext: jsonb("terminal_context").$type<Record<string, string>>(),

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
