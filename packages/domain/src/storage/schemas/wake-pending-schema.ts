import { pgTable, text, uuid, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { WakeSignalPayload } from "../../ask/wake-on-respond";

/**
 * wake_pending table — undelivered Ask wake events for in-conversation drain.
 *
 * Implements the v0 short-term bridge from mt#1519 §5 (catalog) / mt#1661 (this task).
 *
 * Producer side: `PersistentWakeSignalSink` writes one row per `quality.review` Ask
 * `responded` transition. Consumer side: `enrichWakeResponse` MCP middleware drains
 * undelivered rows for the calling session at every allowlisted tool call.
 *
 * **v1 (mt#4476) keys on EITHER grain.** v0 keyed on `parent_session_id` only and
 * recorded that cross-session delivery "require[s] the InterfaceBinding model designed
 * in mt#1506". That was an accurate description of the v0 COLUMN and was then carried
 * forward as though it described a structural limit. It is not: ADR-006 Layer 3
 * (mt#3285, shipped 2026-07-29 — after that note was written) has the MCP server
 * resolving a conversation-grain caller identity on EVERY tool call, so the
 * conversation-keyed path below needs no binding model. mt#1506 remains the general
 * session↔interface binding design; it is no longer this table's blocker.
 *
 * `agent_id` is the ordinary-ask path; `parent_session_id` is the workspace-session
 * path the pr-watch and quality.review producers still use. Exactly one is set per row.
 *
 * Conventions (mirroring asks-schema and pr-watch-schema):
 * - UUID PK with defaultRandom()
 * - No FK constraints — parent_session_id and ask_id are plain text refs
 * - jsonb for the full WakeSignalPayload (operators reading the table see the
 *   payload shape without joining to the asks table)
 * - withTimezone on all timestamps
 * - snake_case column names, camelCase TypeScript identifiers
 *
 * Retirement: v0 retires when mt#1506's InterfaceBinding model lands and is
 * integrated with WakeSignalSink. mt#1001 (mesh push) is the long-term Class A
 * subscriber that may obviate this table entirely.
 */
export const wakePendingTable = pgTable(
  "wake_pending",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Minsky WORKSPACE session UUID this wake is addressed to (`Ask.parentSessionId`).
     *
     * Nullable since mt#4476: a wake is addressed to EITHER a workspace session or a
     * conversation ({@link agentId}), and an ordinary ask filed from a main-workspace
     * conversation has no workspace session at all. Exactly one of the two is set —
     * `insert` rejects a payload carrying neither, so a row that no drain can ever
     * match is never written.
     */
    parentSessionId: text("parent_session_id"),

    /**
     * Conversation-grain caller identity this wake is addressed to, in ADR-006
     * `{kind}:{scope}:{id}` AgentId form (mt#4476).
     *
     * This is the key that makes an ORDINARY answered ask deliverable. The MCP
     * server resolves it on every tool call (`resolveCallerAgentId`,
     * `src/mcp/server.ts`), so the consumer side needs no session argument and no
     * `InterfaceBinding` model (mt#1506) to match a row to its caller.
     *
     * Only an ADR-006 Layer 2/3 (declared/stamped) identity belongs here. A Layer 1
     * ascribed id is a process hash, which ADR-006 itself says "is not a
     * conversation-scoped distinction" — writing one produces a row no conversation
     * can claim.
     */
    agentId: text("agent_id"),

    /** Ask ID that produced this wake event. */
    askId: text("ask_id").notNull(),

    /** Full WakeSignalPayload as JSON (the seven canonical fields). */
    payloadJson: jsonb("payload_json").$type<WakeSignalPayload>().notNull(),

    /** When the producer side wrote this row (reconciler dispatch time). */
    emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * When the consumer side delivered this row to the calling agent. NULL while
     * undelivered. The partial index below filters on this column to keep drain
     * queries fast.
     */
    drainedAt: timestamp("drained_at", { withTimezone: true }),

    /**
     * The MCP tool name on which this wake was delivered. Useful for telemetry —
     * shows which tool calls actually deliver wakes vs which never do.
     */
    drainedForTool: text("drained_for_tool"),
  },
  (table) => ({
    /**
     * Partial index on undelivered rows. The middleware's hot path is
     * "find all undelivered wakes for session S" — this index keeps it O(matches)
     * regardless of total table size.
     */
    undeliveredByParentSession: index("wake_pending_undelivered")
      .on(table.parentSessionId)
      .where(sql`${table.drainedAt} IS NULL`),

    /**
     * The same partial-index shape for the conversation-grain key (mt#4476). The
     * agent-keyed drain runs on EVERY allowlisted tool call of every conversation,
     * so it is the hotter of the two paths and wants its own index rather than
     * sharing one.
     */
    undeliveredByAgent: index("wake_pending_undelivered_by_agent")
      .on(table.agentId)
      .where(sql`${table.drainedAt} IS NULL`),

    /**
     * The addressability invariant, enforced by the DATABASE (PR #3286 R1).
     *
     * `DrizzleWakePendingRepository.insert` already refuses an unaddressable payload,
     * but that guard sits in one application path. This table is written by four
     * producers and is reachable from a migration, a backfill, or a psql session — and
     * the failure it guards against is silent by construction: a row addressed to
     * neither grain matches no drain query, so it sits undelivered forever while every
     * surface reports success. An invariant whose violation produces no error is
     * exactly the kind that belongs in a constraint rather than in a code path.
     */
    addressable: check(
      "wake_pending_addressable",
      sql`${table.parentSessionId} IS NOT NULL OR ${table.agentId} IS NOT NULL`
    ),
  })
);

export type WakePendingRecord = typeof wakePendingTable.$inferSelect;
export type WakePendingInsert = typeof wakePendingTable.$inferInsert;
